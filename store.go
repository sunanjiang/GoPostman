package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// Store 是唯一的数据落地点：一个本地 JSON 文件。
// 刻意不引入数据库、不引入用户表、不引入会话，从根源上不需要登录。
type Store struct {
	mu   sync.RWMutex
	path string
	ws   Workspace
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("读取工作区失败: %w", err)
		}
		s.ws = seedWorkspace()
		if err := s.persist(); err != nil {
			return nil, err
		}
		return s, nil
	}
	var ws Workspace
	if err := json.Unmarshal(data, &ws); err != nil {
		return nil, fmt.Errorf("工作区文件损坏 (%s): %w；可删除该文件后重启以重建", path, err)
	}
	migrated := ws.Settings.SettingsVersion < 2
	s.normalize(&ws)
	s.ws = ws
	// 旧工作区的默认设置迁移后顺手写回文件，避免数据文件里仍显示旧值。
	if migrated {
		s.mu.Lock()
		err := s.persist()
		s.mu.Unlock()
		if err != nil {
			log.Printf("[提示] 设置迁移写入文件失败（不影响本次运行）: %v", err)
		}
	}
	return s, nil
}

func (s *Store) normalize(ws *Workspace) {
	if ws.Version == 0 {
		ws.Version = 1
	}
	if ws.Collections == nil {
		ws.Collections = []Collection{}
	}
	if ws.Environments == nil {
		ws.Environments = []Environment{}
	}
	if ws.Globals == nil {
		ws.Globals = []KV{}
	}
	if ws.History == nil {
		ws.History = []HistoryItem{}
	}
	if ws.Tabs == nil {
		ws.Tabs = []TabState{}
	}
	// 一次性把旧工作区迁移到新默认值：超时不限制、默认忽略 TLS 证书错误、历史 1000 条。
	// 必须用版本号判断而不是「字段为零」——0 本身就是合法的超时值（不限制）。
	if ws.Settings.SettingsVersion < 2 {
		ws.Settings.TimeoutMs = 0
		ws.Settings.InsecureSkipVerify = true
		ws.Settings.HistoryLimit = 1000
		ws.Settings.SettingsVersion = 2
	}
	if ws.Settings.MaxBodyBytes <= 0 {
		ws.Settings.MaxBodyBytes = 8 * 1024 * 1024
	}
	if ws.Settings.HistoryLimit <= 0 {
		ws.Settings.HistoryLimit = 1000
	}
	if len(ws.Tabs) == 0 {
		ws.Tabs = []TabState{{ID: "tab-1", Name: "新请求", Request: RequestSpec{Method: "GET", URL: "", Body: BodyConfig{Mode: "none"}, Auth: AuthConfig{Type: "inherit"}}}}
	}
	if ws.ActiveTabID == "" && len(ws.Tabs) > 0 {
		ws.ActiveTabID = ws.Tabs[0].ID
	}
}

// Get 返回深拷贝，避免调用方在锁外修改共享内存。
func (s *Store) Get() Workspace {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, _ := json.Marshal(s.ws)
	var out Workspace
	_ = json.Unmarshal(b, &out)
	return out
}

func (s *Store) Replace(ws Workspace) error {
	// 前端显式保存过，视为已确认新默认值，避免迁移把用户刚改的设置覆盖掉
	if ws.Settings.SettingsVersion < 2 {
		ws.Settings.SettingsVersion = 2
	}
	s.normalize(&ws)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ws = ws
	return s.persist()
}

func (s *Store) AddHistory(item HistoryItem) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ws.Settings.SaveHistory {
		return
	}
	// 头部插入，按上限截断
	s.ws.History = append([]HistoryItem{item}, s.ws.History...)
	limit := s.ws.Settings.HistoryLimit
	if limit <= 0 {
		limit = 1000
	}
	if len(s.ws.History) > limit {
		s.ws.History = s.ws.History[:limit]
	}
	_ = s.persist()
}

// persist 先写临时文件再原子替换，避免进程中断留下半截 JSON。
// 调用方必须已持有写锁。
func (s *Store) persist() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建数据目录失败: %w", err)
	}
	b, err := json.MarshalIndent(s.ws, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("写入工作区失败: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("替换工作区文件失败: %w", err)
	}
	return nil
}

func (s *Store) Path() string { return s.path }
