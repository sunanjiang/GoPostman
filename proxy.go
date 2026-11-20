package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var variablePattern = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)

// cookieStore 包装标准库 cookiejar，额外记录唯一 cookie 数量供 UI 显示。
// Postman 会在请求间自动携带服务端下发的 Cookie，这里保持同样行为。
type cookieStore struct {
	mu   sync.Mutex
	jar  *cookiejar.Jar
	keys map[string]struct{}
}

func newCookieStore() *cookieStore {
	jar, _ := cookiejar.New(nil)
	return &cookieStore{jar: jar, keys: map[string]struct{}{}}
}

func (c *cookieStore) SetCookies(u *url.URL, cookies []*http.Cookie) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.jar.SetCookies(u, cookies)
	for _, ck := range cookies {
		c.keys[strings.ToLower(u.Host)+"|"+ck.Path+"|"+ck.Name] = struct{}{}
	}
}

func (c *cookieStore) Cookies(u *url.URL) []*http.Cookie {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.jar.Cookies(u)
}

func (c *cookieStore) Count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.keys)
}

func (c *cookieStore) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	jar, _ := cookiejar.New(nil)
	c.jar = jar
	c.keys = map[string]struct{}{}
}

type Proxy struct {
	cookies *cookieStore
}

func NewProxy() *Proxy { return &Proxy{cookies: newCookieStore()} }

func (p *Proxy) CookieCount() int { return p.cookies.Count() }
func (p *Proxy) ClearCookies()    { p.cookies.Clear() }

// Execute 是整台机器的引擎：把一份请求描述真正打到网络上，并把结果原样带回。
func (p *Proxy) Execute(in *SendRequest) SendResponse {
	out := SendResponse{
		OK: false, Headers: map[string][]string{},
		Cookies: []ResponseCookie{}, RequestHeaders: map[string][]string{},
	}
	start := time.Now()

	vars := in.Variables
	if vars == nil {
		vars = map[string]string{}
	}
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = "GET"
	}
	out.Method = method

	rawURL := strings.TrimSpace(resolveVars(in.URL, vars))
	if rawURL == "" {
		out.Error = "URL 不能为空"
		return out
	}
	// 变量可能把 URL 解析成相对路径，这一步必须在 resolveVars 之后做。
	if strings.HasPrefix(rawURL, "/") {
		rawURL = strings.TrimRight(in.BaseURL, "/") + rawURL
	}
	if !strings.Contains(rawURL, "://") {
		rawURL = "http://" + rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		out.Error = "URL 解析失败: " + err.Error()
		return out
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		out.Error = "仅支持 http / https 协议，当前为: " + u.Scheme
		return out
	}
	if u.Host == "" {
		out.Error = "URL 缺少主机名"
		return out
	}

	// Query 统一按标准百分号编码：> → %3E、: → %3A、, → %2C 等。
	// 先解码再编码保证幂等（已是 %3E 不会二次变成 %253E），变量替换后同样编码。
	// Params 表（前端联动后已是 URL 的视图）只做去重追加，避免同一参数发两遍。
	rawQuery := normalizeQuery(u.RawQuery, vars)
	normalized := *u
	normalized.RawQuery = rawQuery
	existing := normalized.Query()
	extras := []string{}
	for _, kv := range in.Params {
		if kv.Disabled || strings.TrimSpace(kv.Key) == "" {
			continue
		}
		key := resolveVars(kv.Key, vars)
		val := resolveVars(kv.Value, vars)
		dup := false
		for _, v := range existing[key] {
			if v == val {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		existing.Add(key, val)
		// 值为空且没有显式等号时写成裸参数段（?TabID like .*）；
		// 用户在 URL 里手写了 "key="，则 ExplicitEq 为真，原样保留那个等号。
		if kv.NoEq || (val == "" && !kv.ExplicitEq) {
			extras = append(extras, queryEscapeKeepVars(key))
		} else {
			extras = append(extras, queryEscapeKeepVars(key)+"="+queryEscapeValue(val))
		}
	}
	if len(extras) > 0 {
		if rawQuery != "" && !strings.HasSuffix(rawQuery, "&") {
			rawQuery += "&"
		}
		rawQuery += strings.Join(extras, "&")
	}
	u.RawQuery = rawQuery

	body, contentType, err := buildBody(in.Body, vars)
	if err != nil {
		out.Error = "构造请求体失败: " + err.Error()
		return out
	}

	req, err := http.NewRequest(method, u.String(), body)
	if err != nil {
		out.Error = "创建请求失败: " + err.Error()
		return out
	}
	for _, kv := range in.Headers {
		if kv.Disabled || strings.TrimSpace(kv.Key) == "" {
			continue
		}
		key := strings.TrimSpace(kv.Key)
		val := resolveVars(kv.Value, vars)
		lower := strings.ToLower(key)
		if lower == "host" {
			req.Host = val
			continue
		}
		if lower == "content-length" || lower == "transfer-encoding" || lower == "connection" {
			continue // 由 Go 传输层管理，手工设置会破坏协议
		}
		req.Header.Add(key, val)
	}
	if contentType != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", contentType)
	}
	applyAuth(req, in.Auth, vars)

	for k, v := range req.Header {
		out.RequestHeaders[k] = append([]string(nil), v...)
	}

	// TimeoutMs <= 0 表示不限制超时：Client.Timeout=0，且各阶段超时也一并放开。
	timeoutMs := in.Options.TimeoutMs
	if timeoutMs < 0 {
		timeoutMs = 0
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	tlsHandshakeTimeout := 10 * time.Second
	if timeout == 0 {
		tlsHandshakeTimeout = 0
	}

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: in.Options.InsecureSkipVerify, // 默认开启，可在设置里关闭
		},
		DisableCompression:    true, // 保留原始响应字节，不悄悄替用户解压
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ResponseHeaderTimeout: timeout,
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{Transport: transport, Jar: p.cookies, Timeout: timeout}
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if !in.Options.FollowRedirects {
			return http.ErrUseLastResponse
		}
		if len(via) >= 10 {
			return fmt.Errorf("重定向超过 10 次，已中止")
		}
		if len(via) > 0 {
			out.Redirects = append(out.Redirects, RedirectHop{
				From: via[len(via)-1].URL.String(), To: next.URL.String(),
			})
		}
		return nil
	}

	resp, err := client.Do(req)
	if err != nil {
		out.TimeMs = time.Since(start).Milliseconds()
		out.Error = friendlyNetError(err)
		return out
	}
	defer resp.Body.Close()

	maxBody := in.Options.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = 8 * 1024 * 1024
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	out.TimeMs = time.Since(start).Milliseconds()
	if int64(len(data)) > maxBody {
		data = data[:maxBody]
		out.Truncated = true
	}
	out.Size = int64(len(data))
	out.TotalSize = resp.ContentLength
	if readErr != nil {
		out.Error = "读取响应体中断: " + readErr.Error()
	}

	ct := resp.Header.Get("Content-Type")
	out.ContentType = ct
	if isTextContent(ct, data) {
		out.Body = string(data)
	} else {
		out.Body = base64.StdEncoding.EncodeToString(data)
		out.BodyBase64 = true
	}
	for k, v := range resp.Header {
		out.Headers[k] = append([]string(nil), v...)
	}
	for _, c := range (&http.Response{Header: resp.Header}).Cookies() {
		out.Cookies = append(out.Cookies, ResponseCookie{
			Name: c.Name, Value: c.Value, Domain: c.Domain, Path: c.Path,
			HTTPOnly: c.HttpOnly, Secure: c.Secure,
			Expires: func() string {
				if c.Expires.IsZero() {
					return ""
				}
				return c.Expires.Format(time.RFC3339)
			}(),
		})
	}
	out.StatusCode = resp.StatusCode
	out.Status = resp.Status
	out.FinalURL = resp.Request.URL.String()
	out.OK = out.Error == ""
	return out
}

func friendlyNetError(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "context deadline exceeded") || strings.Contains(s, "Client.Timeout"):
		return "请求超时（可在设置里调整超时时间）"
	case strings.Contains(s, "certificate") || strings.Contains(s, "x509"):
		return "TLS 证书校验失败：" + s + "（可勾选「忽略证书错误」）"
	case strings.Contains(s, "no such host"):
		return "域名无法解析：" + s
	case strings.Contains(s, "connection refused"):
		return "连接被拒绝：" + s
	case strings.Contains(s, "proxy"):
		return "代理连接失败：" + s
	default:
		return s
	}
}

// jsEscape 的保留字符集与浏览器 encodeURIComponent 完全一致：
// A-Z a-z 0-9 - _ . ! ~ * ' ( ) 不编码，其余按 UTF-8 逐字节百分号编码。
// 这样 URL 里的正则片段（如 ".*"）不会被 Go 的 QueryEscape 转成 ".%2A"，
// 而 ">" "<" ":" "," 空格等仍按标准编码（> → %3E）。
func jsEscape(s string, keepEq bool) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			b.WriteByte(c)
		case keepEq && c == '=':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// queryEscapeKeepVars 用于参数名：标准编码，但保留 {{变量}} 占位符原文，
// 避免占位符被编码成 %7B%7B 后无法再替换。
func queryEscapeKeepVars(s string) string {
	parts := variablePattern.Split(s, -1)
	matches := variablePattern.FindAllString(s, -1)
	var b strings.Builder
	for i, p := range parts {
		b.WriteString(jsEscape(p, false))
		if i < len(matches) {
			b.WriteString(matches[i])
		}
	}
	return b.String()
}

// queryEscapeValue 用于参数值：与参数名同一套规则，但 "=" 保持原样。
// query 只按第一个 "=" 分割 key/value，所以值里的 "="（如 ShotTime>=2026）无需转义。
func queryEscapeValue(s string) string {
	parts := variablePattern.Split(s, -1)
	matches := variablePattern.FindAllString(s, -1)
	var b strings.Builder
	for i, p := range parts {
		b.WriteString(jsEscape(p, true))
		if i < len(matches) {
			b.WriteString(matches[i])
		}
	}
	return b.String()
}

// normalizeQuery 把 URL 里手写的 query 规范化成标准编码。
// 逐段「解码 → 变量替换 → 编码」，因此已是 %3E 的不会变成 %253E（幂等），
// 变量值里含 & = > 等字符也只会被编码在值内部，不会破坏 query 结构。
func normalizeQuery(raw string, vars map[string]string) string {
	if raw == "" {
		return ""
	}
	out := []string{}
	for _, seg := range strings.Split(raw, "&") {
		if seg == "" {
			continue
		}
		if i := strings.IndexByte(seg, '='); i >= 0 {
			k, err := url.QueryUnescape(seg[:i])
			if err != nil {
				k = seg[:i]
			}
			v, err := url.QueryUnescape(seg[i+1:])
			if err != nil {
				v = seg[i+1:]
			}
			out = append(out, queryEscapeKeepVars(resolveVars(k, vars))+"="+queryEscapeValue(resolveVars(v, vars)))
		} else {
			s, err := url.QueryUnescape(seg)
			if err != nil {
				s = seg
			}
			out = append(out, queryEscapeKeepVars(resolveVars(s, vars)))
		}
	}
	return strings.Join(out, "&")
}

// resolveVars 支持 {{name}} 以及 Postman 风格的动态变量 {{$timestamp}} 等。
// 只做一轮替换：变量值里再出现 {{...}} 不会被二次展开，避免循环引用。
func resolveVars(s string, vars map[string]string) string {
	if s == "" || !strings.Contains(s, "{{") {
		return s
	}
	return variablePattern.ReplaceAllStringFunc(s, func(match string) string {
		key := strings.TrimSpace(variablePattern.FindStringSubmatch(match)[1])
		if strings.HasPrefix(key, "$") {
			return dynamicVar(key)
		}
		if v, ok := vars[key]; ok {
			return v
		}
		return match
	})
}

func dynamicVar(name string) string {
	now := time.Now()
	switch strings.ToLower(name) {
	case "$timestamp":
		return strconv.FormatInt(now.Unix(), 10)
	case "$timestampms":
		return strconv.FormatInt(now.UnixMilli(), 10)
	case "$isotimestamp":
		return now.UTC().Format(time.RFC3339)
	case "$guid", "$randomuuid":
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		b[6] = (b[6] & 0x0f) | 0x40
		b[8] = (b[8] & 0x3f) | 0x80
		h := hex.EncodeToString(b)
		return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
	case "$randomint":
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		n := int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])
		if n < 0 {
			n = -n
		}
		return strconv.Itoa(n % 1000)
	case "$randomhex":
		b := make([]byte, 8)
		_, _ = rand.Read(b)
		return hex.EncodeToString(b)
	case "$date":
		return now.Format("2006-01-02")
	default:
		return "{{" + name + "}}"
	}
}

func contentTypeForLang(lang string) string {
	switch strings.ToLower(lang) {
	case "json":
		return "application/json"
	case "xml":
		return "application/xml"
	case "html":
		return "text/html"
	case "javascript", "js":
		return "application/javascript"
	case "graphql":
		return "application/json"
	default:
		return "text/plain"
	}
}

func buildBody(b BodyConfig, vars map[string]string) (io.Reader, string, error) {
	switch b.Mode {
	case "", "none":
		return nil, "", nil

	case "raw":
		return strings.NewReader(resolveVars(b.Raw, vars)), contentTypeForLang(b.RawLang), nil

	case "urlencoded":
		values := url.Values{}
		for _, kv := range b.URLEncoded {
			if kv.Disabled || kv.Key == "" {
				continue
			}
			values.Add(resolveVars(kv.Key, vars), resolveVars(kv.Value, vars))
		}
		return strings.NewReader(values.Encode()), "application/x-www-form-urlencoded", nil

	case "formdata":
		var buf bytes.Buffer
		w := multipart.NewWriter(&buf)
		for _, kv := range b.FormData {
			if kv.Disabled || kv.Key == "" {
				continue
			}
			key := resolveVars(kv.Key, vars)
			if kv.Type == "file" {
				name := kv.FileName
				if name == "" {
					name = "file.bin"
				}
				data, err := decodeBase64(kv.FileData)
				if err != nil {
					return nil, "", fmt.Errorf("字段 %s 的文件内容不是合法 base64: %w", key, err)
				}
				part, err := w.CreateFormFile(key, name)
				if err != nil {
					return nil, "", err
				}
				if _, err := part.Write(data); err != nil {
					return nil, "", err
				}
			} else if err := w.WriteField(key, resolveVars(kv.Value, vars)); err != nil {
				return nil, "", err
			}
		}
		if err := w.Close(); err != nil {
			return nil, "", err
		}
		return &buf, w.FormDataContentType(), nil

	case "graphql":
		var variables any = map[string]any{}
		raw := strings.TrimSpace(resolveVars(b.GraphQLVars, vars))
		if raw != "" {
			if err := json.Unmarshal([]byte(raw), &variables); err != nil {
				return nil, "", fmt.Errorf("GraphQL variables 不是合法 JSON: %w", err)
			}
		}
		payload, err := json.Marshal(map[string]any{
			"query":     resolveVars(b.GraphQLQuery, vars),
			"variables": variables,
		})
		if err != nil {
			return nil, "", err
		}
		return bytes.NewReader(payload), "application/json", nil

	case "binary":
		data, err := decodeBase64(b.BinaryData)
		if err != nil {
			return nil, "", fmt.Errorf("二进制内容不是合法 base64: %w", err)
		}
		return bytes.NewReader(data), "application/octet-stream", nil

	default:
		return nil, "", fmt.Errorf("未知的 body 模式: %s", b.Mode)
	}
}

func decodeBase64(s string) ([]byte, error) {
	if s == "" {
		return []byte{}, nil
	}
	// 兼容前端 FileReader 产出的 data URL
	if i := strings.Index(s, ","); i >= 0 && strings.HasPrefix(s, "data:") {
		s = s[i+1:]
	}
	s = strings.TrimSpace(s)
	if data, err := base64.StdEncoding.DecodeString(s); err == nil {
		return data, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}

func applyAuth(req *http.Request, a AuthConfig, vars map[string]string) {
	switch strings.ToLower(a.Type) {
	case "bearer":
		if t := resolveVars(a.Bearer, vars); t != "" {
			req.Header.Set("Authorization", "Bearer "+t)
		}
	case "basic":
		user := resolveVars(a.Username, vars)
		pass := resolveVars(a.Password, vars)
		if user != "" || pass != "" {
			req.SetBasicAuth(user, pass)
		}
	case "apikey":
		key := resolveVars(a.APIKeyKey, vars)
		val := resolveVars(a.APIKeyValue, vars)
		if key == "" {
			return
		}
		if strings.EqualFold(a.APIKeyIn, "query") {
			// 只追加已编码的键值对，不重新解析整个 query，避免二次编码
			pair := queryEscapeKeepVars(key) + "=" + queryEscapeValue(val)
			if req.URL.RawQuery != "" && !strings.HasSuffix(req.URL.RawQuery, "&") {
				req.URL.RawQuery += "&"
			}
			req.URL.RawQuery += pair
		} else {
			req.Header.Set(key, val)
		}
	}
}

// isTextContent 判断响应体能否安全地当文本展示。
//
//	Content-Type 缺失时做一次可打印字符嗅探，避免把图片二进制硬塞进 <pre>。
func isTextContent(ct string, body []byte) bool {
	lower := strings.ToLower(ct)
	for _, marker := range []string{
		"json", "xml", "text/", "javascript", "x-www-form-urlencoded",
		"graphql", "yaml", "csv", "html", "svg", "sql", "markdown", "multipart/",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	if lower != "" && lower != "application/octet-stream" && lower != "binary/octet-stream" {
		return false
	}
	if len(body) == 0 {
		return true
	}
	if !utf8.Valid(body) {
		return false
	}
	sample := body
	if len(sample) > 1024 {
		sample = sample[:1024]
	}
	printable := 0
	for _, b := range sample {
		if b == '\t' || b == '\n' || b == '\r' || (b >= 32 && b < 127) || b >= 0x80 {
			printable++
		}
	}
	return float64(printable)/float64(len(sample)) > 0.9
}
