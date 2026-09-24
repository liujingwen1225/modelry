//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	allocConsole     = kernel32.NewProc("AllocConsole")
	getConsoleWindow = kernel32.NewProc("GetConsoleWindow")
	showWindow       = syscall.NewLazyDLL("user32.dll").NewProc("ShowWindow")
)

func main() {
	os.Exit(run())
}

func run() int {
	if len(os.Args) < 2 {
		_, _ = fmt.Fprintln(os.Stderr, "usage: modelry-e2e-launcher <runtime> [arguments...]")
		return 2
	}
	if err := ensureHiddenConsole(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "cannot prepare the Runtime console: %v\n", err)
		return 1
	}

	command := exec.Command(os.Args[1], os.Args[2:]...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200}
	if err := command.Start(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "cannot start Modelry Runtime: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintf(os.Stdout, "RUNTIME_PID %d\n", command.Process.Pid)
	if err := command.Wait(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			return exitError.ExitCode()
		}
		_, _ = fmt.Fprintf(os.Stderr, "cannot wait for Modelry Runtime: %v\n", err)
		return 1
	}
	return 0
}

func ensureHiddenConsole() error {
	window, _, _ := getConsoleWindow.Call()
	if window == 0 {
		result, _, callError := allocConsole.Call()
		if result == 0 && callError != syscall.ERROR_ACCESS_DENIED {
			return callError
		}
		window, _, _ = getConsoleWindow.Call()
	}
	if window != 0 {
		showWindow.Call(window, 0)
	}
	return nil
}
