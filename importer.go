package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

func newID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}

// ---------------------------------------------------------------- Postman 导入

// Postman 的 JSON 里很多字段既可能是字符串也可能是对象/数组，所以先用
// RawMessage 接住，再按需解释。这样能兼容 v2.0 / v2.1 以及部分手改过的导出文件。
type pmVar struct {
	Key      string `json:"key"`
	Value    any    `json:"value"`
	Type     string `json:"type"`
	Disabled bool   `json:"disabled"`
}

type pmQuery struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	Disabled bool   `json:"disabled"`
}

type pmURL struct {
	Raw      string          `json:"raw"`
	Protocol string          `json:"protocol"`
	Host     json.RawMessage `json:"host"`
	Port     string          `json:"port"`
	Path     json.RawMessage `json:"path"`
	Query    []pmQuery       `json:"query"`
}

type pmFormField struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Type        string `json:"type"`
	Src         string `json:"src"`
	Disabled    bool   `json:"disabled"`
	ContentType string `json:"contentType"`
}

type pmBody struct {
	Mode       string          `json:"mode"`
	Raw        string          `json:"raw"`
	Options    json.RawMessage `json:"options"`
	FormData   []pmFormField   `json:"formdata"`
	URLEncoded []pmFormField   `json:"urlencoded"`
	GraphQL    json.RawMessage `json:"graphql"`
	File       struct {
		Src string `json:"src"`
	} `json:"file"`
}

type pmEvent struct {
	Listen string `json:"listen"`
	Script struct {
		Type string   `json:"type"`
		Exec []string `json:"exec"`
	} `json:"script"`
}

type pmRequest struct {
	Method      string          `json:"method"`
	Header      json.RawMessage `json:"header"`
	URL         json.RawMessage `json:"url"`
	Body        *pmBody         `json:"body"`
	Auth        json.RawMessage `json:"auth"`
	Description json.RawMessage `json:"description"`
	Event       []pmEvent       `json:"event"` // 有些导出文件把脚本挂在 request 内部
}

type pmItem struct {
	Name        string          `json:"name"`
	Description json.RawMessage `json:"description"`
	Item        []pmItem        `json:"item"`
	Request     json.RawMessage `json:"request"`
	Auth        json.RawMessage `json:"auth"`
	Event       []pmEvent       `json:"event"`
}

type pmCollection struct {
	Info struct {
		Name        string          `json:"name"`
		Description json.RawMessage `json:"description"`
	} `json:"info"`
	Item     []pmItem        `json:"item"`
	Auth     json.RawMessage `json:"auth"`
	Variable []pmVar         `json:"variable"`
	Event    []pmEvent       `json:"event"`
}

type pmEnvironment struct {
	Name   string  `json:"name"`
	Values []pmVar `json:"values"`
}

// parsePostmanBundle 接受：单个集合、单个环境、Postman 全量导出的 dump，
// 或直接是集合数组。返回可直接并入工作区的集合与环境。
func parsePostmanBundle(content string) ([]Collection, []Environment, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, nil, fmt.Errorf("导入内容为空")
	}
	if !strings.HasPrefix(content, "{") && !strings.HasPrefix(content, "[") {
		return nil, nil, fmt.Errorf("内容不是 JSON；若是 cURL 命令请使用「导入 cURL」")
	}

	var raw json.RawMessage = json.RawMessage(content)
	if strings.HasPrefix(content, "{") {
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(raw, &probe); err != nil {
			return nil, nil, fmt.Errorf("JSON 解析失败: %w", err)
		}
		if dumpCols, ok := probe["collections"]; ok {
			var list []json.RawMessage
			_ = json.Unmarshal(dumpCols, &list)
			cols := []Collection{}
			for _, c := range list {
				col, err := parsePostmanCollection(c)
				if err == nil {
					cols = append(cols, col)
				}
			}
			envs := []Environment{}
			if dumpEnvs, ok := probe["environments"]; ok {
				var elist []json.RawMessage
				_ = json.Unmarshal(dumpEnvs, &elist)
				for _, e := range elist {
					if env, err := parsePostmanEnvironment(e); err == nil {
						envs = append(envs, env)
					}
				}
			}
			if len(cols) == 0 && len(envs) == 0 {
				return nil, nil, fmt.Errorf("导出包里没有可导入的集合或环境")
			}
			return cols, envs, nil
		}
		if _, ok := probe["values"]; ok {
			env, err := parsePostmanEnvironment(raw)
			if err != nil {
				return nil, nil, err
			}
			return nil, []Environment{env}, nil
		}
		if _, ok := probe["info"]; !ok {
			return nil, nil, fmt.Errorf("识别不出 Postman 集合格式（缺少 info 字段）")
		}
	}

	if strings.HasPrefix(content, "[") {
		var list []json.RawMessage
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, nil, err
		}
		cols := []Collection{}
		envs := []Environment{}
		for _, item := range list {
			if col, err := parsePostmanCollection(item); err == nil {
				cols = append(cols, col)
				continue
			}
			if env, err := parsePostmanEnvironment(item); err == nil {
				envs = append(envs, env)
			}
		}
		if len(cols)+len(envs) == 0 {
			return nil, nil, fmt.Errorf("数组里没有可识别的集合或环境")
		}
		return cols, envs, nil
	}

	col, err := parsePostmanCollection(raw)
	if err != nil {
		return nil, nil, err
	}
	return []Collection{col}, []Environment{}, nil
}

func parsePostmanCollection(raw json.RawMessage) (Collection, error) {
	var src pmCollection
	if err := json.Unmarshal(raw, &src); err != nil {
		return Collection{}, err
	}
	if src.Info.Name == "" {
		return Collection{}, fmt.Errorf("集合缺少 info.name")
	}
	col := Collection{
		ID:          newID("col"),
		Name:        src.Info.Name,
		Description: rawText(src.Info.Description),
		Items:       []CollectionItem{},
		Auth:        parseAuth(src.Auth),
	}
	for _, v := range src.Variable {
		col.Variables = append(col.Variables, KV{
			Key: v.Key, Value: anyToString(v.Value), Disabled: v.Disabled,
			Secret: strings.EqualFold(v.Type, "secret"),
		})
	}
	for _, item := range src.Item {
		col.Items = append(col.Items, convertItem(item, col.Auth)...)
	}
	return col, nil
}

func convertItem(item pmItem, inheritedAuth AuthConfig) []CollectionItem {
	if len(item.Item) > 0 {
		children := []CollectionItem{}
		for _, sub := range item.Item {
			children = append(children, convertItem(sub, inheritedAuth)...)
		}
		return []CollectionItem{{
			ID: newID("folder"), Name: nonempty(item.Name, "新建文件夹"),
			Type: "folder", Description: rawText(item.Description), Items: children,
		}}
	}
	if len(item.Request) == 0 {
		return nil
	}
	var req pmRequest
	if err := json.Unmarshal(item.Request, &req); err != nil {
		// request 也可能是纯 URL 字符串
		var s string
		if json.Unmarshal(item.Request, &s) == nil && s != "" {
			req = pmRequest{Method: "GET", URL: json.RawMessage(mustJSON(s))}
		} else {
			return nil
		}
	}
	spec := RequestSpec{
		Method:      defaultStr(req.Method, "GET"),
		URL:         parseURLField(req.URL),
		Description: rawText(item.Description),
		Body:        BodyConfig{Mode: "none"},
		Auth:        parseAuth(req.Auth),
	}
	if strings.EqualFold(spec.Auth.Type, "inherit") || spec.Auth.Type == "" {
		spec.Auth = inheritedAuth
	}
	spec.Headers = parseHeaderField(req.Header)
	spec.Params = parseQueryField(req.URL)
	if req.Body != nil {
		spec.Body = convertBody(req.Body)
	}
	events := append([]pmEvent{}, item.Event...)
	events = append(events, req.Event...)
	for _, ev := range events {
		script := strings.Join(ev.Script.Exec, "\n")
		switch strings.ToLower(ev.Listen) {
		case "prerequest":
			spec.PreScript = script
		case "test":
			spec.TestScript = script
		}
	}
	return []CollectionItem{{
		ID: newID("req"), Name: nonempty(item.Name, spec.URL), Type: "request",
		Description: spec.Description, Request: &spec,
	}}
}

func parseURLField(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var u pmURL
	if json.Unmarshal(raw, &u) != nil {
		return ""
	}
	if u.Raw != "" {
		return u.Raw
	}
	var b strings.Builder
	if u.Protocol != "" {
		b.WriteString(u.Protocol)
		b.WriteString("://")
	} else {
		b.WriteString("https://")
	}
	hosts := asStringList(u.Host)
	b.WriteString(strings.Join(hosts, "."))
	if u.Port != "" {
		b.WriteString(":" + u.Port)
	}
	paths := asStringList(u.Path)
	if len(paths) > 0 {
		b.WriteString("/" + strings.Join(paths, "/"))
	}
	return b.String()
}

func parseQueryField(raw json.RawMessage) []KV {
	var u pmURL
	if len(raw) == 0 || json.Unmarshal(raw, &u) != nil {
		return []KV{}
	}
	out := []KV{}
	if u.Raw != "" {
		if parsed, err := url.Parse(u.Raw); err == nil {
			for k, vs := range parsed.Query() {
				for _, v := range vs {
					out = append(out, KV{Key: k, Value: v})
				}
			}
		}
		return out
	}
	for _, q := range u.Query {
		out = append(out, KV{Key: q.Key, Value: q.Value, Disabled: q.Disabled})
	}
	return out
}

func parseHeaderField(raw json.RawMessage) []KV {
	if len(raw) == 0 {
		return []KV{}
	}
	var list []struct {
		Key      string `json:"key"`
		Value    string `json:"value"`
		Disabled bool   `json:"disabled"`
	}
	if json.Unmarshal(raw, &list) == nil {
		out := []KV{}
		for _, h := range list {
			out = append(out, KV{Key: h.Key, Value: h.Value, Disabled: h.Disabled})
		}
		return out
	}
	// 有些导出文件把 header 存成 "Key: Value\nKey2: Value2" 字符串
	var text string
	if json.Unmarshal(raw, &text) == nil {
		out := []KV{}
		for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
			if i := strings.Index(line, ":"); i > 0 {
				out = append(out, KV{Key: strings.TrimSpace(line[:i]), Value: strings.TrimSpace(line[i+1:])})
			}
		}
		return out
	}
	return []KV{}
}

func convertBody(b *pmBody) BodyConfig {
	out := BodyConfig{Mode: b.Mode}
	switch b.Mode {
	case "raw":
		out.Raw = b.Raw
		out.RawLang = bodyLanguage(b.Options)
	case "urlencoded":
		out.Mode = "urlencoded"
		for _, f := range b.URLEncoded {
			out.URLEncoded = append(out.URLEncoded, KV{Key: f.Key, Value: f.Value, Disabled: f.Disabled})
		}
	case "formdata":
		for _, f := range b.FormData {
			kv := KV{Key: f.Key, Value: f.Value, Disabled: f.Disabled, Type: "text"}
			if f.Type == "file" || f.Src != "" {
				kv.Type = "file"
				kv.FileName = f.Src
				if idx := strings.LastIndexAny(f.Src, `/\`); idx >= 0 {
					kv.FileName = f.Src[idx+1:]
				}
				kv.Value = f.Src
			}
			out.FormData = append(out.FormData, kv)
		}
	case "graphql":
		var g struct {
			Query     string `json:"query"`
			Variables string `json:"variables"`
		}
		_ = json.Unmarshal(b.GraphQL, &g)
		out.GraphQLQuery = g.Query
		out.GraphQLVars = g.Variables
	case "file":
		out.Mode = "binary"
		out.BinaryName = b.File.Src
		out.Raw = ""
	default:
		out.Mode = "none"
	}
	return out
}

func bodyLanguage(options json.RawMessage) string {
	if len(options) == 0 {
		return "text"
	}
	var o struct {
		Raw struct {
			Language string `json:"language"`
		} `json:"raw"`
	}
	if json.Unmarshal(options, &o) == nil && o.Raw.Language != "" {
		return o.Raw.Language
	}
	return "text"
}

func parseAuth(raw json.RawMessage) AuthConfig {
	if len(raw) == 0 {
		return AuthConfig{Type: "inherit"}
	}
	var a struct {
		Type   string          `json:"type"`
		Bearer json.RawMessage `json:"bearer"`
		Basic  json.RawMessage `json:"basic"`
		APIKey json.RawMessage `json:"apikey"`
	}
	if json.Unmarshal(raw, &a) != nil {
		return AuthConfig{Type: "inherit"}
	}
	switch strings.ToLower(a.Type) {
	case "bearer":
		return AuthConfig{Type: "bearer", Bearer: authField(a.Bearer, "token")}
	case "basic":
		return AuthConfig{Type: "basic", Username: authField(a.Basic, "username"), Password: authField(a.Basic, "password")}
	case "apikey":
		return AuthConfig{
			Type: "apikey", APIKeyKey: authField(a.APIKey, "key"),
			APIKeyValue: authField(a.APIKey, "value"), APIKeyIn: defaultStr(authField(a.APIKey, "in"), "header"),
		}
	case "noauth":
		return AuthConfig{Type: "none"}
	default:
		return AuthConfig{Type: "inherit"}
	}
}

// authField 解析 Postman 的 [{key,value,type}] 形式配置数组。
func authField(raw json.RawMessage, key string) string {
	if len(raw) == 0 {
		return ""
	}
	var list []struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	}
	if json.Unmarshal(raw, &list) == nil {
		for _, item := range list {
			if strings.EqualFold(item.Key, key) {
				return anyToString(item.Value)
			}
		}
		return ""
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil {
		return anyToString(m[key])
	}
	return ""
}

func parsePostmanEnvironment(raw json.RawMessage) (Environment, error) {
	var src pmEnvironment
	if err := json.Unmarshal(raw, &src); err != nil {
		return Environment{}, fmt.Errorf("环境文件解析失败: %w", err)
	}
	if src.Name == "" && len(src.Values) == 0 {
		return Environment{}, fmt.Errorf("不是有效的 Postman 环境文件")
	}
	env := Environment{ID: newID("env"), Name: nonempty(src.Name, "导入的环境"), Values: []KV{}}
	for _, v := range src.Values {
		env.Values = append(env.Values, KV{
			Key: v.Key, Value: anyToString(v.Value), Disabled: v.Disabled,
			Secret: strings.EqualFold(v.Type, "secret"),
		})
	}
	return env, nil
}

// ---------------------------------------------------------------- cURL 互转

func parseCurl(command string) (RequestSpec, error) {
	tokens, err := tokenizeShell(command)
	if err != nil {
		return RequestSpec{}, err
	}
	if len(tokens) == 0 {
		return RequestSpec{}, fmt.Errorf("命令为空")
	}
	if !strings.HasSuffix(strings.ToLower(tokens[0]), "curl") {
		return RequestSpec{}, fmt.Errorf("请以 curl 开头")
	}
	spec := RequestSpec{Method: "", URL: "", Body: BodyConfig{Mode: "none"}, Auth: AuthConfig{Type: "inherit"}}
	dataParts := []string{}
	urlEncodedParts := []KV{}
	formParts := []KV{}
	explicitMethod := ""
	headOnly := false
	forceGet := false
	contentType := ""
	var targetURL string

	for i := 1; i < len(tokens); i++ {
		t := tokens[i]
		next := func() string {
			if i+1 < len(tokens) {
				i++
				return tokens[i]
			}
			return ""
		}
		switch t {
		case "-X", "--request":
			explicitMethod = strings.ToUpper(next())
		case "-H", "--header":
			h := next()
			if h == "" || strings.HasPrefix(h, "@") {
				continue
			}
			if idx := strings.Index(h, ":"); idx > 0 {
				key := strings.TrimSpace(h[:idx])
				val := strings.TrimSpace(h[idx+1:])
				if strings.EqualFold(key, "Content-Type") {
					contentType = val
				}
				if strings.EqualFold(key, "Authorization") && strings.HasPrefix(strings.ToLower(val), "bearer ") {
					spec.Auth = AuthConfig{Type: "bearer", Bearer: strings.TrimSpace(val[7:])}
					continue
				}
				spec.Headers = append(spec.Headers, KV{Key: key, Value: val})
			}
		case "-d", "--data", "--data-raw", "--data-binary", "--data-ascii":
			v := next()
			if strings.HasPrefix(v, "@") {
				continue // 引用文件，无法从命令还原内容
			}
			dataParts = append(dataParts, v)
		case "--data-urlencode":
			v := next()
			if k, val, ok := strings.Cut(v, "="); ok {
				urlEncodedParts = append(urlEncodedParts, KV{Key: k, Value: val})
			} else {
				dataParts = append(dataParts, v)
			}
		case "-F", "--form":
			v := next()
			k, val, _ := strings.Cut(v, "=")
			kv := KV{Key: k, Value: val, Type: "text"}
			if strings.HasPrefix(val, "@") {
				kv.Type = "file"
				kv.FileName = strings.TrimPrefix(val, "@")
			}
			formParts = append(formParts, kv)
		case "-u", "--user":
			user, pass, _ := strings.Cut(next(), ":")
			spec.Auth = AuthConfig{Type: "basic", Username: user, Password: pass}
		case "-A", "--user-agent":
			spec.Headers = append(spec.Headers, KV{Key: "User-Agent", Value: next()})
		case "-e", "--referer":
			spec.Headers = append(spec.Headers, KV{Key: "Referer", Value: next()})
		case "-b", "--cookie":
			v := next()
			if !strings.HasPrefix(v, "@") {
				spec.Headers = append(spec.Headers, KV{Key: "Cookie", Value: v})
			}
		case "--url":
			targetURL = next()
		case "-G", "--get":
			forceGet = true
		case "-I", "--head":
			headOnly = true
		case "-k", "--insecure", "-L", "--location", "-s", "--silent", "-v", "--verbose",
			"-i", "--include", "--compressed", "-S", "--show-error", "--fail", "-f",
			"--http1.1", "--http2", "--no-keepalive":
			// 这些开关由应用设置统一管理，导入时忽略
		case "-o", "--output", "--connect-timeout", "--max-time", "--retry", "--proxy", "-x":
			next() // 带值但与请求内容无关的开关
		default:
			if strings.HasPrefix(t, "-") {
				continue
			}
			if targetURL == "" {
				targetURL = t
			}
		}
	}
	if targetURL == "" {
		return RequestSpec{}, fmt.Errorf("cURL 命令里找不到 URL")
	}
	spec.URL = targetURL
	if u, err := url.Parse(targetURL); err == nil {
		for k, vs := range u.Query() {
			for _, v := range vs {
				spec.Params = append(spec.Params, KV{Key: k, Value: v})
			}
		}
	}

	if len(formParts) > 0 {
		spec.Body = BodyConfig{Mode: "formdata", FormData: formParts}
	} else if len(urlEncodedParts) > 0 || (len(dataParts) > 0 && strings.Contains(contentType, "x-www-form-urlencoded")) {
		for _, part := range dataParts {
			for _, pair := range strings.Split(part, "&") {
				if k, v, ok := strings.Cut(pair, "="); ok {
					decodedK, _ := url.QueryUnescape(k)
					decodedV, _ := url.QueryUnescape(v)
					urlEncodedParts = append(urlEncodedParts, KV{Key: decodedK, Value: decodedV})
				}
			}
		}
		spec.Body = BodyConfig{Mode: "urlencoded", URLEncoded: urlEncodedParts}
	} else if len(dataParts) > 0 {
		joined := strings.Join(dataParts, "&")
		lang := "text"
		if strings.Contains(contentType, "json") || json.Valid([]byte(joined)) {
			lang = "json"
		} else if strings.Contains(contentType, "xml") {
			lang = "xml"
		}
		spec.Body = BodyConfig{Mode: "raw", Raw: joined, RawLang: lang}
	}
	if contentType != "" {
		found := false
		for _, h := range spec.Headers {
			if strings.EqualFold(h.Key, "Content-Type") {
				found = true
			}
		}
		if !found {
			spec.Headers = append(spec.Headers, KV{Key: "Content-Type", Value: contentType})
		}
	}
	switch {
	case explicitMethod != "":
		spec.Method = explicitMethod
	case headOnly:
		spec.Method = "HEAD"
	case forceGet:
		spec.Method = "GET"
	case spec.Body.Mode != "none":
		spec.Method = "POST"
	default:
		spec.Method = "GET"
	}
	return spec, nil
}

func tokenizeShell(cmd string) ([]string, error) {
	cmd = strings.ReplaceAll(cmd, "\\\r\n", " ")
	cmd = strings.ReplaceAll(cmd, "\\\n", " ")
	cmd = strings.ReplaceAll(cmd, "^\r\n", " ")
	cmd = strings.ReplaceAll(cmd, "^\n", " ")
	tokens := []string{}
	var buf strings.Builder
	var quote rune
	escaped := false
	flush := func() {
		if buf.Len() > 0 {
			tokens = append(tokens, buf.String())
			buf.Reset()
		}
	}
	for _, r := range cmd {
		if escaped {
			buf.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			} else {
				buf.WriteRune(r)
			}
			continue
		}
		switch r {
		case '\'', '"':
			quote = r
		case ' ', '\t', '\n', '\r':
			flush()
		default:
			buf.WriteRune(r)
		}
	}
	if quote != 0 {
		return nil, fmt.Errorf("引号未闭合")
	}
	if escaped {
		buf.WriteRune('\\')
	}
	flush()
	return tokens, nil
}

func buildCurl(spec RequestSpec) string {
	var b strings.Builder
	b.WriteString("curl")
	method := strings.ToUpper(defaultStr(spec.Method, "GET"))
	if method != "GET" {
		b.WriteString(" -X " + shellQuote(method))
	}
	b.WriteString(" " + shellQuote(curlURL(spec)))
	for _, h := range spec.Headers {
		if h.Disabled || h.Key == "" {
			continue
		}
		b.WriteString(" \\\n  -H " + shellQuote(h.Key+": "+h.Value))
	}
	switch spec.Auth.Type {
	case "bearer":
		b.WriteString(" \\\n  -H " + shellQuote("Authorization: Bearer "+spec.Auth.Bearer))
	case "basic":
		b.WriteString(" \\\n  -u " + shellQuote(spec.Auth.Username+":"+spec.Auth.Password))
	case "apikey":
		if strings.EqualFold(spec.Auth.APIKeyIn, "query") {
			b.WriteString(" \\\n  # API Key 已拼入 URL 查询参数")
		} else {
			b.WriteString(" \\\n  -H " + shellQuote(spec.Auth.APIKeyKey+": "+spec.Auth.APIKeyValue))
		}
	}
	switch spec.Body.Mode {
	case "raw":
		b.WriteString(" \\\n  --data-raw " + shellQuote(spec.Body.Raw))
	case "urlencoded":
		for _, kv := range spec.Body.URLEncoded {
			if kv.Disabled || kv.Key == "" {
				continue
			}
			b.WriteString(" \\\n  --data-urlencode " + shellQuote(kv.Key+"="+kv.Value))
		}
	case "formdata":
		for _, kv := range spec.Body.FormData {
			if kv.Disabled || kv.Key == "" {
				continue
			}
			if kv.Type == "file" {
				b.WriteString(" \\\n  -F " + shellQuote(kv.Key+"=@"+nonempty(kv.FileName, "file.bin")))
			} else {
				b.WriteString(" \\\n  -F " + shellQuote(kv.Key+"="+kv.Value))
			}
		}
	case "graphql":
		payload, _ := json.Marshal(map[string]any{
			"query": spec.Body.GraphQLQuery, "variables": json.RawMessage(nonempty(spec.Body.GraphQLVars, "{}")),
		})
		b.WriteString(" \\\n  --data-raw " + shellQuote(string(payload)))
	case "binary":
		b.WriteString(" \\\n  --data-binary @" + shellQuote(nonempty(spec.Body.BinaryName, "file.bin")))
	}
	return b.String()
}

func curlURL(spec RequestSpec) string {
	base, hash := spec.URL, ""
	if i := strings.IndexByte(base, '#'); i >= 0 {
		base, hash = base[:i], base[i:]
	}
	extras := []string{}
	// 前端联动后 URL 已包含 Params；仅在 URL 无 query 的旧数据上补一次
	if !strings.Contains(base, "?") {
		for _, kv := range spec.Params {
			if kv.Disabled || kv.Key == "" {
				continue
			}
			if kv.NoEq || (kv.Value == "" && !kv.ExplicitEq) {
				extras = append(extras, kv.Key)
			} else {
				extras = append(extras, kv.Key+"="+kv.Value)
			}
		}
	}
	if spec.Auth.Type == "apikey" && strings.EqualFold(spec.Auth.APIKeyIn, "query") && spec.Auth.APIKeyKey != "" {
		extras = append(extras, spec.Auth.APIKeyKey+"="+spec.Auth.APIKeyValue)
	}
	if len(extras) > 0 {
		sep := "?"
		if strings.Contains(base, "?") {
			sep = "&"
			if strings.HasSuffix(base, "?") || strings.HasSuffix(base, "&") {
				sep = ""
			}
		}
		base += sep + strings.Join(extras, "&")
	}
	return base + hash // 导出保留原始 URL（shellQuote 会用单引号包住），编码只在发请求时做
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ---------------------------------------------------------------- 小工具

func rawText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Content string `json:"content"`
		Type    string `json:"type"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Content != "" {
		return obj.Content
	}
	return ""
}

func asStringList(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		return list
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && s != "" {
		return []string{s}
	}
	return nil
}

func anyToString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", x), "0"), ".")
	case bool:
		if x {
			return "true"
		}
		return "false"
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

func defaultStr(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func nonempty(s, fallback string) string { return defaultStr(s, fallback) }

func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
