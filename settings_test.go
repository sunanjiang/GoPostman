package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultSettings(t *testing.T) {
	s := defaultSettings()
	if s.TimeoutMs != 0 {
		t.Errorf("默认超时应为 0（不限制），实际 %d", s.TimeoutMs)
	}
	if !s.InsecureSkipVerify {
		t.Error("默认应忽略 TLS 证书错误")
	}
	if s.HistoryLimit != 1000 {
		t.Errorf("默认历史上限应为 1000，实际 %d", s.HistoryLimit)
	}
	if s.SettingsVersion != 2 {
		t.Errorf("默认设置版本应为 2，实际 %d", s.SettingsVersion)
	}
}

// 旧工作区一次性迁移到新默认值；迁移后用户显式修改不能被再次覆盖。
func TestSettingsMigrationRunsOnlyOnce(t *testing.T) {
	s := &Store{}
	ws := Workspace{Settings: Settings{
		TimeoutMs: 30000, InsecureSkipVerify: false, HistoryLimit: 100,
		MaxBodyBytes: 8388608, FollowRedirects: true, SaveHistory: true,
	}}
	s.normalize(&ws)
	if ws.Settings.TimeoutMs != 0 || !ws.Settings.InsecureSkipVerify ||
		ws.Settings.HistoryLimit != 1000 || ws.Settings.SettingsVersion != 2 {
		t.Fatalf("迁移结果不对: %+v", ws.Settings)
	}
	// 用户显式改成有限超时、关闭忽略证书、历史上限 200，再次规范化应原样保留
	ws.Settings.TimeoutMs = 5000
	ws.Settings.InsecureSkipVerify = false
	ws.Settings.HistoryLimit = 200
	s.normalize(&ws)
	if ws.Settings.TimeoutMs != 5000 || ws.Settings.InsecureSkipVerify || ws.Settings.HistoryLimit != 200 {
		t.Fatalf("用户显式设置被迁移覆盖: %+v", ws.Settings)
	}
}

// Replace 视为「前端已确认设置」，不能让迁移把刚保存的值冲掉。
func TestReplaceKeepsExplicitSettings(t *testing.T) {
	s, err := NewStore(filepath.Join(t.TempDir(), "workspace.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws := s.Get()
	ws.Settings.TimeoutMs = 8000
	ws.Settings.InsecureSkipVerify = false
	ws.Settings.HistoryLimit = 50
	ws.Settings.SettingsVersion = 0 // 模拟旧前端 PUT 没带版本号
	if err := s.Replace(ws); err != nil {
		t.Fatal(err)
	}
	got := s.Get().Settings
	if got.TimeoutMs != 8000 || got.InsecureSkipVerify || got.HistoryLimit != 50 {
		t.Fatalf("Replace 路径不应迁移用户设置: %+v", got)
	}
}

// 旧工作区在启动时迁移，并把新默认值写回文件，而不只是留在内存里。
func TestMigrationIsPersisted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workspace.json")
	old := Workspace{Version: 1, Settings: Settings{
		TimeoutMs: 30000, InsecureSkipVerify: false, HistoryLimit: 100,
		MaxBodyBytes: 8388608, FollowRedirects: true, SaveHistory: true,
	}}
	b, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got Workspace
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Settings.TimeoutMs != 0 || !got.Settings.InsecureSkipVerify ||
		got.Settings.HistoryLimit != 1000 || got.Settings.SettingsVersion != 2 {
		t.Fatalf("迁移结果未写入文件: %+v", got.Settings)
	}
}

// 0 = 不限制；正数仍然作为毫秒超时生效。
func TestTimeoutZeroIsUnlimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(120 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	p := NewProxy()

	unlimited := p.Execute(&SendRequest{
		RequestSpec: RequestSpec{Method: "GET", URL: srv.URL},
		Options:     SendOptions{TimeoutMs: 0, FollowRedirects: true},
	})
	if !unlimited.OK {
		t.Fatalf("0 超时不应限制请求: %s", unlimited.Error)
	}

	limited := p.Execute(&SendRequest{
		RequestSpec: RequestSpec{Method: "GET", URL: srv.URL},
		Options:     SendOptions{TimeoutMs: 1, FollowRedirects: true},
	})
	if limited.OK {
		t.Fatal("1ms 超时本应失败")
	}
}

// 自签名证书：默认忽略时可通，关闭后应报证书错误。
func TestInsecureSkipVerifyToggle(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	p := NewProxy()

	ok := p.Execute(&SendRequest{
		RequestSpec: RequestSpec{Method: "GET", URL: srv.URL},
		Options:     SendOptions{TimeoutMs: 5000, FollowRedirects: true, InsecureSkipVerify: true},
	})
	if !ok.OK {
		t.Fatalf("默认忽略证书错误时应能访问自签名服务: %s", ok.Error)
	}
	bad := p.Execute(&SendRequest{
		RequestSpec: RequestSpec{Method: "GET", URL: srv.URL},
		Options:     SendOptions{TimeoutMs: 5000, FollowRedirects: true, InsecureSkipVerify: false},
	})
	if bad.OK {
		t.Fatal("关闭忽略证书后应校验失败")
	}
}
