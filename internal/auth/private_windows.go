package auth

import "os"

// Windows protects the file through the per-user profile directory's ACL.
func checkPrivate(string, os.FileInfo) error { return nil }
