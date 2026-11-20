package main

// 本文件定义前后端共用的数据模型。所有结构都以 JSON 直出，前端不需要任何转换层。

// KV 是通用键值行，用于 headers / params / form-data / urlencoded / variables。
// 用 Disabled 而非 Enabled：JSON 零值天然表示"启用"，避免导入数据时漏字段导致整行被跳过。
type KV struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Description string `json:"description,omitempty"`
	Disabled    bool   `json:"disabled,omitempty"`
	Type        string `json:"type,omitempty"` // form-data 专用: "text" | "file"
	FileName    string `json:"fileName,omitempty"`
	FileData    string `json:"fileData,omitempty"`   // base64，仅 file 类型
	Secret      bool   `json:"secret,omitempty"`     // 环境变量: secret 类型，UI 上掩码显示
	NoEq        bool   `json:"noEq,omitempty"`       // query 里没有 "=" 的裸参数段
	ExplicitEq  bool   `json:"explicitEq,omitempty"` // URL 里显式写了 "key="，即使值为空也保留等号
}

// BodyConfig 覆盖 Postman Body 面板的全部模式。
type BodyConfig struct {
	Mode         string `json:"mode,omitempty"` // none | raw | formdata | urlencoded | graphql | binary
	Raw          string `json:"raw,omitempty"`
	RawLang      string `json:"rawLang,omitempty"` // json | xml | text | html | javascript
	FormData     []KV   `json:"formData,omitempty"`
	URLEncoded   []KV   `json:"urlEncoded,omitempty"`
	GraphQLQuery string `json:"graphqlQuery,omitempty"`
	GraphQLVars  string `json:"graphqlVariables,omitempty"`
	BinaryName   string `json:"binaryName,omitempty"`
	BinaryData   string `json:"binaryData,omitempty"` // base64
}

// AuthConfig 支持最常用的几种认证。OAuth2 的完整授权流程需要云端回调，本地工具里
// 直接让用户把 token 填进 Bearer 更实用，因此不实现交互式 OAuth。
type AuthConfig struct {
	Type        string `json:"type,omitempty"` // inherit | none | bearer | basic | apikey
	Bearer      string `json:"bearer,omitempty"`
	Username    string `json:"username,omitempty"`
	Password    string `json:"password,omitempty"`
	APIKeyKey   string `json:"apiKeyKey,omitempty"`
	APIKeyValue string `json:"apiKeyValue,omitempty"`
	APIKeyIn    string `json:"apiKeyIn,omitempty"` // header | query
}

// RequestSpec 是一个完整的请求描述，既用于保存到集合，也用于发送。
type RequestSpec struct {
	Method      string     `json:"method"`
	URL         string     `json:"url"`
	Params      []KV       `json:"params,omitempty"`
	Headers     []KV       `json:"headers,omitempty"`
	Body        BodyConfig `json:"body,omitempty"`
	Auth        AuthConfig `json:"auth,omitempty"`
	PreScript   string     `json:"preScript,omitempty"`
	TestScript  string     `json:"testScript,omitempty"`
	Description string     `json:"description,omitempty"`
}

type SendOptions struct {
	TimeoutMs          int   `json:"timeoutMs,omitempty"`
	FollowRedirects    bool  `json:"followRedirects"`
	InsecureSkipVerify bool  `json:"insecureSkipVerify,omitempty"`
	MaxBodyBytes       int64 `json:"maxBodyBytes,omitempty"`
}

type SendRequest struct {
	RequestSpec
	Options   SendOptions       `json:"options"`
	Variables map[string]string `json:"variables,omitempty"` // 已由前端解析好的变量作用域
	BaseURL   string            `json:"baseUrl,omitempty"`   // 服务端自身地址，用于补全变量替换后产生的相对路径
}

type ResponseCookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain,omitempty"`
	Path     string `json:"path,omitempty"`
	Expires  string `json:"expires,omitempty"`
	HTTPOnly bool   `json:"httpOnly,omitempty"`
	Secure   bool   `json:"secure,omitempty"`
}

type RedirectHop struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Status int    `json:"status"`
}

type SendResponse struct {
	OK             bool                `json:"ok"`
	Error          string              `json:"error,omitempty"`
	StatusCode     int                 `json:"statusCode"`
	Status         string              `json:"status"`
	TimeMs         int64               `json:"timeMs"`
	Size           int64               `json:"size"` // 实际读到的字节数
	TotalSize      int64               `json:"totalSize,omitempty"`
	Truncated      bool                `json:"truncated,omitempty"`
	Headers        map[string][]string `json:"headers"`
	Cookies        []ResponseCookie    `json:"cookies"`
	Body           string              `json:"body"`
	BodyBase64     bool                `json:"bodyBase64"`
	ContentType    string              `json:"contentType"`
	FinalURL       string              `json:"finalURL"`
	Redirects      []RedirectHop       `json:"redirects,omitempty"`
	RequestHeaders map[string][]string `json:"requestHeaders,omitempty"`
	Method         string              `json:"method,omitempty"`
}

type CollectionItem struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Type        string           `json:"type"` // folder | request
	Description string           `json:"description,omitempty"`
	Request     *RequestSpec     `json:"request,omitempty"`
	Items       []CollectionItem `json:"items,omitempty"`
}

type Collection struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Items       []CollectionItem `json:"items"`
	Variables   []KV             `json:"variables,omitempty"`
	Auth        AuthConfig       `json:"auth,omitempty"`
}

type Environment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Values   []KV   `json:"values"`
	IsGlobal bool   `json:"isGlobal,omitempty"`
}

type HistoryItem struct {
	ID         string      `json:"id"`
	At         int64       `json:"at"` // Unix 毫秒
	Method     string      `json:"method"`
	URL        string      `json:"url"`
	StatusCode int         `json:"statusCode"`
	TimeMs     int64       `json:"timeMs"`
	Request    RequestSpec `json:"request"`
}

type TabState struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Request      RequestSpec `json:"request"`
	SavedID      string      `json:"savedId,omitempty"`
	CollectionID string      `json:"collectionId,omitempty"`
	Dirty        bool        `json:"dirty,omitempty"`
}

type Settings struct {
	TimeoutMs          int  `json:"timeoutMs"` // 0 表示不限制超时
	FollowRedirects    bool `json:"followRedirects"`
	InsecureSkipVerify bool `json:"insecureSkipVerify"`
	MaxBodyBytes       int  `json:"maxBodyBytes"`
	SaveHistory        bool `json:"saveHistory"`
	HistoryLimit       int  `json:"historyLimit"`
	// SettingsVersion 用于把旧工作区一次性迁移到新默认值。
	// 迁移只发生一次，之后用户显式修改的设置不会被覆盖。
	SettingsVersion int `json:"settingsVersion,omitempty"`
}

type Workspace struct {
	Version      int           `json:"version"`
	Collections  []Collection  `json:"collections"`
	Environments []Environment `json:"environments"`
	ActiveEnvID  string        `json:"activeEnvId"`
	Globals      []KV          `json:"globals"`
	History      []HistoryItem `json:"history"`
	Tabs         []TabState    `json:"tabs"`
	ActiveTabID  string        `json:"activeTabId"`
	Settings     Settings      `json:"settings"`
}

func defaultSettings() Settings {
	return Settings{
		TimeoutMs:          0, // 不限制
		FollowRedirects:    true,
		InsecureSkipVerify: true,
		MaxBodyBytes:       8 * 1024 * 1024,
		SaveHistory:        true,
		HistoryLimit:       1000,
		SettingsVersion:    2,
	}
}

// seedWorkspace 生成一个开箱即用的工作区。示例请求指向本机 /api/echo，
// 因此完全断网也能点"发送"验证整条链路。
func seedWorkspace() Workspace {
	echo := "{{base_url}}/api/echo"
	tabReq := RequestSpec{
		Method: "GET",
		URL:    echo,
		Params: []KV{
			{Key: "hello", Value: "world"},
		},
		Headers: []KV{
			{Key: "Accept", Value: "application/json"},
		},
		Body: BodyConfig{Mode: "none"},
		Auth: AuthConfig{Type: "inherit"},
	}
	return Workspace{
		Version: 1,
		Environments: []Environment{
			{
				ID:   "env-local",
				Name: "Local (本机)",
				Values: []KV{
					{Key: "base_url", Value: ""},
					{Key: "token", Value: "demo-token", Secret: true},
				},
			},
		},
		ActiveEnvID: "env-local",
		Globals:     []KV{{Key: "version", Value: "v1"}},
		Collections: []Collection{
			{
				ID:          "col-demo",
				Name:        "示例集合 · 本机 Echo",
				Description: "免登录、离线可用。所有示例请求都打到本服务的 /api/echo。",
				Variables:   []KV{{Key: "api_version", Value: "v1"}},
				Items: []CollectionItem{
					{ID: "req-1", Name: "GET 回显", Type: "request", Request: &RequestSpec{
						Method: "GET", URL: echo, Body: BodyConfig{Mode: "none"}, Auth: AuthConfig{Type: "inherit"},
						Params: []KV{{Key: "hello", Value: "world"}},
					}},
					{ID: "req-2", Name: "POST JSON", Type: "request", Request: &RequestSpec{
						Method: "POST", URL: echo, Body: BodyConfig{Mode: "raw", RawLang: "json", Raw: "{\n  \"name\": \"gopostman\",\n  \"version\": \"{{version}}\"\n}"},
						Auth:    AuthConfig{Type: "inherit"},
						Headers: []KV{{Key: "Content-Type", Value: "application/json"}},
					}},
					{ID: "req-3", Name: "POST 表单", Type: "request", Request: &RequestSpec{
						Method: "POST", URL: echo, Auth: AuthConfig{Type: "inherit"},
						Body: BodyConfig{Mode: "urlencoded", URLEncoded: []KV{{Key: "user", Value: "admin"}, {Key: "pwd", Value: "123456"}}},
					}},
					{ID: "req-4", Name: "带 Bearer 鉴权", Type: "request", Request: &RequestSpec{
						Method: "GET", URL: echo, Body: BodyConfig{Mode: "none"},
						Auth: AuthConfig{Type: "bearer", Bearer: "{{token}}"},
					}},
				},
			},
		},
		History: []HistoryItem{},
		Tabs: []TabState{
			{ID: "tab-1", Name: "GET 回显", Request: tabReq},
		},
		ActiveTabID: "tab-1",
		Settings:    defaultSettings(),
	}
}
