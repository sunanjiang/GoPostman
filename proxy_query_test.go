package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 这些测试用 httptest 内存服务器，不需要启动常驻服务，也不依赖外网。

func executeAgainst(t *testing.T, handler func(w http.ResponseWriter, r *http.Request), in *SendRequest) SendResponse {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(handler))
	defer srv.Close()
	in.URL = srv.URL + in.URL
	in.Options.TimeoutMs = 5000
	in.Options.FollowRedirects = true
	return NewProxy().Execute(in)
}

func TestURLQueryIsPercentEncoded(t *testing.T) {
	const input = "where=ShotTime>20261112000000&sort=a,b:desc&range={{ts}}"
	const want = "where=ShotTime%3E20261112000000&sort=a%2Cb%3Adesc&range=12345"
	var got string
	resp := executeAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}, &SendRequest{
		RequestSpec: RequestSpec{Method: "GET", URL: "/search?" + input},
		Variables:   map[string]string{"ts": "12345"},
	})
	if !resp.OK {
		t.Fatalf("请求失败: %s", resp.Error)
	}
	if got != want {
		t.Fatalf("query 未按标准编码\n期望: %s\n实际: %s", want, got)
	}
}

func TestBareSegmentWithoutEquals(t *testing.T) {
	const want = "ShotTime%3E20261112000000"
	var got string
	resp := executeAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}, &SendRequest{RequestSpec: RequestSpec{Method: "GET", URL: "/list?ShotTime>20261112000000"}})
	if !resp.OK || got != want {
		t.Fatalf("无等号裸参数编码不对: ok=%v got=%q want=%q", resp.OK, got, want)
	}
}

func TestParamsAlreadyInURLAreNotDuplicated(t *testing.T) {
	var got string
	resp := executeAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}, &SendRequest{
		RequestSpec: RequestSpec{
			Method: "GET", URL: "/api?hello=world&where=ShotTime>2026",
			Params: []KV{{Key: "hello", Value: "world"}, {Key: "where", Value: "ShotTime>2026"}},
		},
	})
	if !resp.OK {
		t.Fatalf("请求失败: %s", resp.Error)
	}
	const want = "hello=world&where=ShotTime%3E2026"
	if got != want {
		t.Fatalf("Params 与 URL 重复发送或编码不对: %s，期望 %s", got, want)
	}
}

func TestExtraParamsAreAppendedWithStandardEncoding(t *testing.T) {
	var got string
	resp := executeAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}, &SendRequest{
		RequestSpec: RequestSpec{
			Method: "GET", URL: "/api",
			Params: []KV{
				{Key: "filter", Value: "ShotTime>20261112000000"},
				{Key: "tag", Value: "a b&c"},
				{Key: "token", Value: "{{token}}"},
				{Key: "eq", Value: "a=b"},
				{Key: "raw", Value: "", NoEq: true},
			},
		},
		Variables: map[string]string{"token": "T-123"},
	})
	if !resp.OK {
		t.Fatalf("请求失败: %s", resp.Error)
	}
	want := "filter=ShotTime%3E20261112000000&tag=a%20b%26c&token=T-123&eq=a=b&raw"
	if got != want {
		t.Fatalf("追加参数编码不符合预期\n期望: %s\n实际: %s", want, got)
	}
}

// 只有 key 的表达式参数（TabID like .*）与显式空等号：
// 页面保持原文；Params 里没填 value 默认不写 "="；URL 里手写的 "=" 要保留。
func TestBareExpressionAndExplicitEq(t *testing.T) {
	cases := []struct {
		name string
		in   *SendRequest
		want string
	}{
		{
			name: "URL 里直接写裸表达式",
			in:   &SendRequest{RequestSpec: RequestSpec{Method: "GET", URL: "/list?TabID like .*"}},
			want: "TabID%20like%20.*",
		},
		{
			name: "Params 表里 key 有值 value 为空",
			in: &SendRequest{RequestSpec: RequestSpec{
				Method: "GET", URL: "/list",
				Params: []KV{{Key: "TabID like .*", Value: ""}},
			}},
			want: "TabID%20like%20.*",
		},
		{
			name: "Params 表标记 NoEq",
			in: &SendRequest{RequestSpec: RequestSpec{
				Method: "GET", URL: "/list",
				Params: []KV{{Key: "TabID like .*", Value: "", NoEq: true}},
			}},
			want: "TabID%20like%20.*",
		},
		{
			name: "URL 里显式写了空等号",
			in:   &SendRequest{RequestSpec: RequestSpec{Method: "GET", URL: "/list?TabID like .*="}},
			want: "TabID%20like%20.*=",
		},
		{
			name: "Params 行显式空等号（来自 URL）",
			in: &SendRequest{RequestSpec: RequestSpec{
				Method: "GET", URL: "/list",
				Params: []KV{{Key: "TabID like .*", Value: "", ExplicitEq: true}},
			}},
			want: "TabID%20like%20.*=",
		},
		{
			name: "有值时正常带等号",
			in: &SendRequest{RequestSpec: RequestSpec{
				Method: "GET", URL: "/list",
				Params: []KV{{Key: "TabID like .*", Value: "x"}},
			}},
			want: "TabID%20like%20.*=x",
		},
	}
	for _, c := range cases {
		var got string
		resp := executeAgainst(t, func(w http.ResponseWriter, r *http.Request) {
			got = r.URL.RawQuery
			w.WriteHeader(http.StatusOK)
		}, c.in)
		if !resp.OK {
			t.Fatalf("%s: 请求失败: %s", c.name, resp.Error)
		}
		if got != c.want {
			t.Errorf("%s: 实际 %q，期望 %q", c.name, got, c.want)
		}
	}
}

func TestQueryEscapeKeepVars(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"ShotTime>20261112000000", "ShotTime%3E20261112000000"},
		{"a:b,c|d", "a%3Ab%2Cc%7Cd"},
		{"a b&c", "a%20b%26c"},
		{"a+b", "a%2Bb"},
		{"k=v", "k%3Dv"},
		{"时间>2026", "%E6%97%B6%E9%97%B4%3E2026"},
		{"{{base_url}}", "{{base_url}}"},
		{"p={{token}}", "p%3D{{token}}"}, // 占位符保留，等号按标准编码
	}
	for _, c := range cases {
		if got := queryEscapeKeepVars(c.in); got != c.want {
			t.Errorf("queryEscapeKeepVars(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 参数值里的 = 保持原样，其他符号仍按标准编码。
func TestEqualsInValueStaysLiteral(t *testing.T) {
	var got string
	resp := executeAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}, &SendRequest{RequestSpec: RequestSpec{
		Method: "GET", URL: "/search?where=ShotTime>=20261112000000&eq=a=b&sort=a,b:desc",
	}})
	if !resp.OK {
		t.Fatalf("请求失败: %s", resp.Error)
	}
	want := "where=ShotTime%3E=20261112000000&eq=a=b&sort=a%2Cb%3Adesc"
	if got != want {
		t.Fatalf("参数值里的 = 被错误编码\n期望: %s\n实际: %s", want, got)
	}
}

func TestQueryEscapeValue(t *testing.T) {
	cases := []struct{ in, want string }{
		{"a=b", "a=b"},
		{"ShotTime>=2026", "ShotTime%3E=2026"},
		{"a=b>c,d", "a=b%3Ec%2Cd"},
		{"{{token}}", "{{token}}"},
	}
	for _, c := range cases {
		if got := queryEscapeValue(c.in); got != c.want {
			t.Errorf("queryEscapeValue(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 幂等：已编码的 %3E 不能被二次编码成 %253E。
func TestNormalizeQueryIdempotent(t *testing.T) {
	vars := map[string]string{"token": "T-123"}
	raw := "where=ShotTime>2026&sort=a,b:desc&p={{token}}&already=ShotTime%3E2026&eq=a=b"
	once := normalizeQuery(raw, vars)
	twice := normalizeQuery(once, vars)
	if once != twice {
		t.Fatalf("归一化不幂等\n第一次: %s\n第二次: %s", once, twice)
	}
	if strings.Contains(once, "%25") {
		t.Fatalf("出现了二次编码: %s", once)
	}
	want := "where=ShotTime%3E2026&sort=a%2Cb%3Adesc&p=T-123&already=ShotTime%3E2026&eq=a=b"
	if once != want {
		t.Fatalf("归一化结果不对\n期望: %s\n实际: %s", want, once)
	}
}

// 变量值里含 & = > 时，& 要编码以免破坏结构，= 保持原样，> 按标准编码。
func TestVariableValueKeepsQueryStructure(t *testing.T) {
	got := normalizeQuery("q={{v}}", map[string]string{"v": "a>b&c=d"})
	want := "q=a%3Eb%26c=d"
	if got != want {
		t.Fatalf("变量值特殊字符处理不对: got %s, want %s", got, want)
	}
}
