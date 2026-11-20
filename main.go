// GoPostman —— 一个完全本地、无需登录的 Web 版 API 调试工具。
//
// 设计取舍：
//  1. 没有账号体系、没有 session、没有云同步。所有数据落在一个本地 JSON 文件里。
//  2. 浏览器受同源策略限制无法直连任意 API，因此由本机 Go 服务代发请求（/api/send）。
//  3. 仅依赖 Go 标准库，go build 即可产出单文件可执行程序。
package main

import (
	"embed"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:web
var embeddedWeb embed.FS

type Server struct {
	store *Store
	proxy *Proxy
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "监听地址（默认只绑定本机，避免被外网访问）")
	data := flag.String("data", "data/workspace.json", "本地工作区文件路径")
	flag.Parse()

	store, err := NewStore(*data)
	if err != nil {
		log.Fatalf("[启动失败] %v", err)
	}
	srv := &Server{store: store, proxy: NewProxy()}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/meta", srv.handleMeta)
	mux.HandleFunc("/api/workspace", srv.handleWorkspace)
	mux.HandleFunc("/api/send", srv.handleSend)
	mux.HandleFunc("/api/cookies", srv.handleCookies)
	mux.HandleFunc("/api/import/postman", srv.handleImportPostman)
	mux.HandleFunc("/api/import/environment", srv.handleImportEnvironment)
	mux.HandleFunc("/api/parse/curl", srv.handleParseCurl)
	mux.HandleFunc("/api/export/curl", srv.handleExportCurl)
	mux.HandleFunc("/api/echo", srv.handleEcho)

	assets, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", spaHandler(assets))

	abs, _ := filepath.Abs(*data)
	fmt.Println()
	fmt.Println("  GoPostman 已启动")
	fmt.Printf("  打开浏览器:  http://%s\n", *addr)
	fmt.Printf("  本地数据:    %s\n", abs)
	fmt.Println("  登录:        不需要（无账号体系 / 无云同步 / 完全离线可用）")
	fmt.Println("  按 Ctrl+C 停止")
	fmt.Println()

	server := &http.Server{
		Addr:              *addr,
		Handler:           withLogging(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[服务异常] %v", err)
	}
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if !strings.HasPrefix(r.URL.Path, "/assets/") && r.URL.Path != "/favicon.ico" {
			log.Printf("%-7s %-32s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}

// spaHandler 提供静态资源；未知路径回退到 index.html。
func spaHandler(assets fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(assets))
	indexBytes, _ := fs.ReadFile(assets, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(assets, p); err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			w.Header().Set("Pragma", "no-cache")
			_, _ = w.Write(indexBytes)
			return
		}
		// 前端是 embed 进二进制的，升级后必须让浏览器立刻拿到新版本，
		// 否则会继续用缓存里的旧 app.js，出现"改了却没生效"的假象。
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		fileServer.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func decodeJSON(r *http.Request, v any) error {
	r.Body = io.NopCloser(io.LimitReader(r.Body, 64<<20)) // 64MB，容得下 base64 二进制
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	return dec.Decode(v)
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          "GoPostman",
		"version":       "1.0.0",
		"authRequired":  false,
		"cloudSync":     false,
		"localOnly":     true,
		"dataFile":      s.store.Path(),
		"cookieCount":   s.proxy.CookieCount(),
		"supportedBody": []string{"none", "raw", "formdata", "urlencoded", "graphql", "binary"},
		"supportedAuth": []string{"inherit", "none", "bearer", "basic", "apikey"},
	})
}

func (s *Server) handleWorkspace(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.store.Get())
	case http.MethodPut:
		var ws Workspace
		if err := decodeJSON(r, &ws); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON 解析失败: " + err.Error()})
			return
		}
		if err := s.store.Replace(ws); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req SendRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, SendResponse{OK: false, Error: "请求体解析失败: " + err.Error()})
		return
	}
	// 变量替换之后可能产生相对路径（例如 {{base_url}} 为空时得到 /api/echo），
	// 把本服务地址交给代理层，由它在替换完成后再做一次补全。
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	req.BaseURL = scheme + "://" + r.Host
	resp := s.proxy.Execute(&req)
	if resp.OK && s.store.Get().Settings.SaveHistory {
		s.store.AddHistory(HistoryItem{
			ID:         fmt.Sprintf("h-%d", time.Now().UnixNano()),
			At:         time.Now().UnixMilli(),
			Method:     req.Method,
			URL:        req.URL,
			StatusCode: resp.StatusCode,
			TimeMs:     resp.TimeMs,
			Request:    req.RequestSpec,
		})
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleCookies(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.proxy.ClearCookies()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleEcho 是一个内置的本地回显端点，用于离线自测：请求怎么发出去的，就怎么照原样回显。
func (s *Server) handleEcho(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		body = []byte(err.Error())
	}
	ct := r.Header.Get("Content-Type")
	bodyStr := string(body)
	bodyIsBase64 := false
	if !isTextContent(ct, body) {
		bodyStr = base64.StdEncoding.EncodeToString(body)
		bodyIsBase64 = true
	}
	q := map[string][]string{}
	for k, v := range r.URL.Query() {
		q[k] = v
	}
	headers := map[string][]string{}
	for k, v := range r.Header {
		headers[k] = v
	}
	cookies := []map[string]string{}
	for _, c := range r.Cookies() {
		cookies = append(cookies, map[string]string{"name": c.Name, "value": c.Value})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-GoPostman-Echo", "local")
	w.Header().Set("Set-Cookie", "gopostman_demo=hello; Path=/; Max-Age=3600; SameSite=Lax")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"message":     "这是 GoPostman 本机回显端点，全程未经过任何第三方服务器",
		"method":      r.Method,
		"path":        r.URL.Path,
		"query":       q,
		"rawQuery":    r.URL.RawQuery, // 用于验证 query 的最终百分号编码结果
		"headers":     headers,
		"cookies":     cookies,
		"contentType": ct,
		"body":        bodyStr,
		"bodyBase64":  bodyIsBase64,
		"bodySize":    len(body),
		"serverTime":  time.Now().Format(time.RFC3339),
	})
}

func (s *Server) handleImportPostman(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var payload struct {
		Content string `json:"content"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	collections, envs, err := parsePostmanBundle(payload.Content)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "collections": collections, "environments": envs})
}

func (s *Server) handleImportEnvironment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var payload struct {
		Content string `json:"content"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	env, err := parsePostmanEnvironment([]byte(payload.Content))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "environment": env})
}

func (s *Server) handleParseCurl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var payload struct {
		Command string `json:"command"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	spec, err := parseCurl(payload.Command)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "request": spec})
}

func (s *Server) handleExportCurl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var spec RequestSpec
	if err := decodeJSON(r, &spec); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "command": buildCurl(spec)})
}
