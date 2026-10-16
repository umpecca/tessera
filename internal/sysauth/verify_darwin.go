package sysauth

import (
	"context"
	"fmt"
	"sync"

	"github.com/ebitengine/purego"
)

const (
	coreFoundationPath        = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
	openDirectoryPath         = "/System/Library/Frameworks/OpenDirectory.framework/OpenDirectory"
	kCFStringEncodingUTF8     = 0x08000100
	kODNodeTypeAuthentication = 0x2201
	// kODRecordTypeUsers' value; building the string avoids reading the
	// framework's exported CFString constant.
	odRecordTypeUsers = "dsRecTypeStandard:Users"
)

var (
	loadOnce sync.Once
	loadErr  error

	cfStringCreateWithBytes  func(allocator uintptr, bytes *byte, length int, encoding uint32, external bool) uintptr
	cfRelease                func(ref uintptr)
	odSessionCreate          func(allocator, options uintptr, err *uintptr) uintptr
	odNodeCreateWithNodeType func(allocator, session uintptr, nodeType uint32, err *uintptr) uintptr
	odNodeCopyRecord         func(node, recordType, name, attributes uintptr, err *uintptr) uintptr
	odRecordVerifyPassword   func(record, password uintptr, err *uintptr) bool
)

func load() error {
	loadOnce.Do(func() {
		cf, err := purego.Dlopen(coreFoundationPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			loadErr = err
			return
		}
		od, err := purego.Dlopen(openDirectoryPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			loadErr = err
			return
		}
		purego.RegisterLibFunc(&cfStringCreateWithBytes, cf, "CFStringCreateWithBytes")
		purego.RegisterLibFunc(&cfRelease, cf, "CFRelease")
		purego.RegisterLibFunc(&odSessionCreate, od, "ODSessionCreate")
		purego.RegisterLibFunc(&odNodeCreateWithNodeType, od, "ODNodeCreateWithNodeType")
		purego.RegisterLibFunc(&odNodeCopyRecord, od, "ODNodeCopyRecord")
		purego.RegisterLibFunc(&odRecordVerifyPassword, od, "ODRecordVerifyPassword")
	})
	return loadErr
}

func cfString(value []byte) uintptr {
	if len(value) == 0 {
		return cfStringCreateWithBytes(0, nil, 0, kCFStringEncodingUTF8, false)
	}
	return cfStringCreateWithBytes(0, &value[0], len(value), kCFStringEncodingUTF8, false)
}

// release frees CoreFoundation objects, including CFErrors returned through
// out parameters.
func release(refs ...uintptr) {
	for _, ref := range refs {
		if ref != 0 {
			cfRelease(ref)
		}
	}
}

// verify looks the account up on the authentication search node and asks
// OpenDirectory to check the password, as the login window does. It never
// runs dscl, which would put the password in process arguments.
func verify(_ context.Context, account string, password []byte) error {
	if err := load(); err != nil {
		return fmt.Errorf("%w: load OpenDirectory: %v", ErrUnavailable, err)
	}
	var cfErr uintptr
	session := odSessionCreate(0, 0, &cfErr)
	defer release(session, cfErr)
	if session == 0 {
		return fmt.Errorf("%w: OpenDirectory session", ErrUnavailable)
	}
	var nodeErr uintptr
	node := odNodeCreateWithNodeType(0, session, kODNodeTypeAuthentication, &nodeErr)
	defer release(node, nodeErr)
	if node == 0 {
		return fmt.Errorf("%w: OpenDirectory search node", ErrUnavailable)
	}
	recordType, name := cfString([]byte(odRecordTypeUsers)), cfString([]byte(account))
	defer release(recordType, name)
	var recordErr uintptr
	record := odNodeCopyRecord(node, recordType, name, 0, &recordErr)
	defer release(record, recordErr)
	if record == 0 {
		return fmt.Errorf("%w: account %q not found", ErrUnavailable, account)
	}
	secret := cfString(password)
	defer release(secret)
	if secret == 0 {
		return ErrIncorrect
	}
	var verifyErr uintptr
	ok := odRecordVerifyPassword(record, secret, &verifyErr)
	release(verifyErr)
	if !ok {
		// Wrong passwords, disabled accounts and expired passwords all end
		// here; none of them may sign in.
		return ErrIncorrect
	}
	return nil
}
