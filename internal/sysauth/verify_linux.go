package sysauth

import "context"

func verify(ctx context.Context, account string, password []byte) error {
	return verifyWithHelper(ctx, unixChkpwdPaths, account, password)
}
