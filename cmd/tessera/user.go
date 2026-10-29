package main

import (
	"bufio"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"

	"golang.org/x/term"

	"tessera/internal/auth"
)

const userUsage = `usage: tessera user <command> [-auth-file path] [name]

Manage accounts for -auth=file. Changes apply to a running server at once.

commands:
  add <name>      create an account (prompts for a password); -admin makes
                  it an admin, as the first account always is
  passwd <name>   change a password; ends that account's sign-ins
  admin <name>    let an account manage accounts and sign-in in Settings;
                  -revoke takes that away
  remove <name>   delete an account; ends its sign-ins
  list            show account names
`

// runUserCommand implements `tessera user`. Passwords are read from the
// terminal without echo, or from standard input with -password-stdin, and
// never from arguments, which other local users can see.
func runUserCommand(args []string, stdin io.Reader, stdout, stderr io.Writer, readHidden func() ([]byte, error)) error {
	if len(args) == 0 {
		fmt.Fprint(stderr, userUsage)
		return errors.New("missing command")
	}
	command := args[0]
	flags := flag.NewFlagSet("tessera user "+command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	path := flags.String("auth-file", auth.DefaultCredentialsPath(), "credentials file")
	fromStdin := flags.Bool("password-stdin", false, "read the password from the first line of standard input")
	makeAdmin := flags.Bool("admin", false, "with add: make the account an admin")
	revoke := flags.Bool("revoke", false, "with admin: stop the account being an admin")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	rest := flags.Args()

	accounts, err := auth.ReadCredentialsFile(*path)
	if errors.Is(err, os.ErrNotExist) {
		accounts, err = nil, nil
	}
	if err != nil {
		return err
	}
	index := func(name string) int {
		return slices.IndexFunc(accounts, func(a auth.Account) bool { return a.Name == name })
	}

	if command == "list" {
		if len(rest) != 0 {
			return errors.New("list takes no arguments")
		}
		for _, account := range accounts {
			if account.Admin {
				fmt.Fprintln(stdout, account.Name, "(admin)")
			} else {
				fmt.Fprintln(stdout, account.Name)
			}
		}
		return nil
	}
	if len(rest) != 1 {
		fmt.Fprint(stderr, userUsage)
		return fmt.Errorf("%s needs exactly one account name", command)
	}
	name := rest[0]
	if err := auth.ValidateName(name); err != nil {
		return err
	}

	switch command {
	case "add", "passwd":
		at := index(name)
		if command == "add" && at >= 0 {
			return fmt.Errorf("%w: %s", auth.ErrAccountExists, name)
		}
		if command == "passwd" && at < 0 {
			return fmt.Errorf("%w: %s", auth.ErrNoAccount, name)
		}
		password, err := readNewPassword(*fromStdin, stdin, stderr, readHidden)
		if err != nil {
			return err
		}
		defer clear(password)
		hash, err := auth.HashPassword(password)
		if err != nil {
			return err
		}
		if at >= 0 {
			accounts[at].Hash = hash
		} else {
			accounts = append(accounts, auth.Account{Name: name, Hash: hash, Admin: *makeAdmin || len(accounts) == 0})
		}
	case "admin":
		at := index(name)
		if at < 0 {
			return fmt.Errorf("%w: %s", auth.ErrNoAccount, name)
		}
		accounts[at].Admin = !*revoke
	case "remove":
		at := index(name)
		if at < 0 {
			return fmt.Errorf("%w: %s", auth.ErrNoAccount, name)
		}
		accounts = slices.Delete(accounts, at, at+1)
	default:
		fmt.Fprint(stderr, userUsage)
		return fmt.Errorf("unknown command %q", command)
	}
	if err := auth.WriteCredentialsFile(*path, accounts); err != nil {
		return err
	}
	switch command {
	case "add":
		role := ""
		if accounts[len(accounts)-1].Admin {
			role = " as an admin"
		}
		fmt.Fprintf(stdout, "Added %s%s to %s\n", name, role, *path)
	case "admin":
		if *revoke {
			fmt.Fprintf(stdout, "%s is no longer an admin\n", name)
		} else {
			fmt.Fprintf(stdout, "%s is now an admin\n", name)
		}
	case "passwd":
		fmt.Fprintf(stdout, "Changed the password for %s; its existing sign-ins have ended\n", name)
	case "remove":
		fmt.Fprintf(stdout, "Removed %s; its sign-ins have ended (its workspaces are kept)\n", name)
	}
	return nil
}

func readNewPassword(fromStdin bool, stdin io.Reader, stderr io.Writer, readHidden func() ([]byte, error)) ([]byte, error) {
	if fromStdin {
		line, err := bufio.NewReader(stdin).ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		line = bytes.TrimRight(line, "\r\n")
		return line, auth.ValidatePassword(line)
	}
	if readHidden == nil {
		return nil, errors.New("no terminal to read a password from; use -password-stdin")
	}
	fmt.Fprint(stderr, "Password: ")
	first, err := readHidden()
	fmt.Fprintln(stderr)
	if err != nil {
		return nil, err
	}
	fmt.Fprint(stderr, "Repeat password: ")
	second, err := readHidden()
	fmt.Fprintln(stderr)
	defer clear(second)
	if err != nil {
		clear(first)
		return nil, err
	}
	if !bytes.Equal(first, second) {
		clear(first)
		return nil, errors.New("passwords do not match")
	}
	return first, auth.ValidatePassword(first)
}

// terminalPasswordReader reads from the controlling terminal without echo, or
// returns nil when standard input is not a terminal.
func terminalPasswordReader() func() ([]byte, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return nil
	}
	return func() ([]byte, error) { return term.ReadPassword(fd) }
}
