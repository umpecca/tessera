package httpapi

import "testing"

func TestParseWorkspacePath(t *testing.T) {
	cases := []struct {
		path    string
		wantID  string
		wantSub string
		wantOK  bool
	}{
		{"/api/workspace/", "", "", true},
		{"/api/workspace/default", "default", "", true},
		{"/api/workspace/alice", "alice", "", true},
		{"/api/workspace/a%20b", "a b", "", true},
		{"/api/workspace/alice/background", "alice", "background", true},
		{"/api/workspace//background", "", "background", true},
		{"/api/workspace/alice/background/extra", "", "", false},
		{"/api/workspace/a%2Fb", "", "", false},
		{"/api/workspace/a%5Cb", "", "", false},
	}
	for _, tc := range cases {
		gotID, gotSub, gotOK := parseWorkspacePath(tc.path)
		if gotID != tc.wantID || gotSub != tc.wantSub || gotOK != tc.wantOK {
			t.Errorf("parseWorkspacePath(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tc.path, gotID, gotSub, gotOK, tc.wantID, tc.wantSub, tc.wantOK)
		}
	}
}

func TestUserAllowed(t *testing.T) {
	single := &API{}
	if !single.userAllowed("default") {
		t.Error("single-user mode should allow the default workspace")
	}
	if !single.userAllowed("") {
		t.Error("single-user mode should allow the empty (default) id")
	}
	if single.userAllowed("alice") {
		t.Error("single-user mode should reject non-default workspaces")
	}

	multi := &API{Users: []string{"alice", "bob"}}
	if !multi.userAllowed("alice") || !multi.userAllowed("bob") {
		t.Error("multi-user mode should allow rostered users")
	}
	if multi.userAllowed("default") {
		t.Error("multi-user mode should not allow the default workspace")
	}
	if multi.userAllowed("carol") {
		t.Error("multi-user mode should reject users outside the roster")
	}
}
