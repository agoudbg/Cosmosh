package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/editor"
	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/install"
	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/paths"
	"github.com/agoudbg/cosmosh/packages/remote-bootstrap/internal/session"
)

// main dispatches remote bootstrap install and status commands.
func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "expected command: install or status")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "install":
		runInstall(os.Args[2:])
	case "status":
		runStatus(os.Args[2:])
	case "licenses":
		fmt.Print(session.ThirdPartyNotices)
	case "session":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGPIPE)
		defer stop()
		if err := session.RunStandardIO(ctx); err != nil {
			os.Exit(1)
		}
	case "editor-request":
		// SSH channel teardown must allow the worker to clean its owned socket before exiting.
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGPIPE)
		defer stop()
		if err := editor.RunRequest(ctx, os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
	case "path-query":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGPIPE)
		defer stop()
		if err := paths.Run(ctx, os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
	case "editor-widget":
		if err := editor.RunWidget(os.Args[2:], os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
	case "editor-input-lock":
		if err := editor.ClaimInputLock(os.Args[2:]); err != nil { os.Exit(1) }
	case "editor-identity":
		if len(os.Args) != 3 {
			os.Exit(1)
		}
		pid, err := strconv.Atoi(os.Args[2])
		if err != nil {
			os.Exit(1)
		}
		start, err := editor.ProcessStart(pid)
		if err != nil {
			os.Exit(1)
		}
		fmt.Println(start)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func runInstall(args []string) {
	flags := flag.NewFlagSet("install", flag.ExitOnError)
	options := install.Options{Stdout: os.Stdout}
	flags.StringVar(&options.Shell, "shell", "", "target shell")
	flags.StringVar(&options.Version, "version", "", "bootstrap version")
	_ = flags.Parse(args)

	if err := install.Run(options); err != nil {
		os.Exit(1)
	}
}

func runStatus(args []string) {
	flags := flag.NewFlagSet("status", flag.ExitOnError)
	shell := ""
	flags.StringVar(&shell, "shell", "sh", "target shell")
	_ = flags.Parse(args)

	if err := install.Status(os.Stdout, shell); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
