//go:build windows

package secretstore

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

func secureNewKeyFile(path string, _ *os.File) error {
	user, err := currentUserSID()
	if err != nil {
		return err
	}
	expected, err := ownerOnlyDescriptor(user)
	if err != nil {
		return err
	}
	dacl, _, err := expected.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	); err != nil {
		return err
	}
	return verifyKeyAccess(path, nil)
}

func verifyKeyAccess(path string, file *os.File) error {
	user, err := currentUserSID()
	if err != nil {
		return err
	}
	if file == nil {
		return verifyWindowsKeyAccess(path, 0, user)
	}
	raw, err := file.SyscallConn()
	if err != nil {
		return ErrKeyInvalid
	}
	var verifyErr error
	err = raw.Control(func(handle uintptr) {
		verifyErr = verifyWindowsKeyAccess("", windows.Handle(handle), user)
	})
	if err != nil || verifyErr != nil {
		return ErrKeyInvalid
	}
	return nil
}

func currentUserSID() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return nil, ErrKeyInvalid
	}
	return user.User.Sid, nil
}

func ownerOnlyDescriptor(user *windows.SID) (*windows.SECURITY_DESCRIPTOR, error) {
	sddl := fmt.Sprintf("D:P(A;;FA;;;%s)", user.String())
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil || descriptor == nil || !descriptor.IsValid() {
		return nil, ErrKeyInvalid
	}
	return descriptor, nil
}

func verifyWindowsKeyAccess(path string, handle windows.Handle, user *windows.SID) error {
	requested := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION | windows.OWNER_SECURITY_INFORMATION)
	descriptor, err := getKeySecurityInfo(path, handle, requested)
	if err != nil || descriptor == nil || !descriptor.IsValid() {
		return ErrKeyInvalid
	}
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil || !windows.EqualSid(owner, user) {
		return ErrKeyInvalid
	}
	control, _, err := descriptor.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return ErrKeyInvalid
	}
	actualDACL, err := getKeySecurityInfo(path, handle, windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION))
	if err != nil || actualDACL == nil {
		return ErrKeyInvalid
	}
	expected, err := ownerOnlyDescriptor(user)
	if err != nil {
		return ErrKeyInvalid
	}
	actual, want := actualDACL.String(), expected.String()
	if actual != want && actual != strings.Replace(want, "D:P", "D:PAI", 1) {
		return ErrKeyInvalid
	}
	return nil
}

func getKeySecurityInfo(path string, handle windows.Handle, information windows.SECURITY_INFORMATION) (*windows.SECURITY_DESCRIPTOR, error) {
	if handle != 0 {
		return windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, information)
	}
	return windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, information)
}
