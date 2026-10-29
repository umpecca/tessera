package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"

	"tessera/internal/auth"
)

// Accounts returns Tessera's own accounts in the order they were added.
func (s *Store) Accounts(ctx context.Context) ([]auth.Account, error) {
	accounts, err := loadAccounts(ctx, s.db)
	if err != nil {
		return nil, fmt.Errorf("load accounts: %w", err)
	}
	return accounts, nil
}

// Account returns one account, and false when there is none by that name.
func (s *Store) Account(ctx context.Context, name string) (auth.Account, bool, error) {
	account := auth.Account{Name: name}
	err := s.db.QueryRowContext(ctx, `SELECT hash, admin FROM auth_accounts WHERE name = ?`, name).
		Scan(&account.Hash, &account.Admin)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.Account{}, false, nil
	}
	if err != nil {
		return auth.Account{}, false, fmt.Errorf("load account: %w", err)
	}
	return account, true, nil
}

// UpdateAccounts applies change to the current accounts and saves the
// result in one transaction, so edits from Settings and `tessera user`
// don't overwrite each other.
func (s *Store) UpdateAccounts(ctx context.Context, change func([]auth.Account) ([]auth.Account, error)) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	accounts, err := loadAccounts(ctx, tx)
	if err != nil {
		return fmt.Errorf("load accounts: %w", err)
	}
	updated, err := change(slices.Clone(accounts))
	if err != nil {
		return err
	}
	if err := saveAccounts(ctx, tx, accounts, updated); err != nil {
		return fmt.Errorf("save accounts: %w", err)
	}
	return tx.Commit()
}

const accountsFileImportedKey = "accounts_file_imported"

// ImportAccounts adds the accounts of the credentials file used before
// accounts moved into the database. It does so once, and only into a
// database without accounts, so accounts removed since never come back. It
// reports whether it added them.
func (s *Store) ImportAccounts(ctx context.Context, accounts []auth.Account) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var done int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM host_settings WHERE key = ?`, accountsFileImportedKey).Scan(&done); err != nil {
		return false, fmt.Errorf("import accounts: %w", err)
	}
	if done > 0 {
		return false, nil
	}
	existing, err := loadAccounts(ctx, tx)
	if err != nil {
		return false, fmt.Errorf("import accounts: %w", err)
	}
	imported := len(existing) == 0 && len(accounts) > 0
	if imported {
		if err := saveAccounts(ctx, tx, nil, accounts); err != nil {
			return false, fmt.Errorf("import accounts: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO host_settings (key, value, updated_at) VALUES (?, 'true', ?)`,
		accountsFileImportedKey, nowText()); err != nil {
		return false, fmt.Errorf("import accounts: %w", err)
	}
	return imported, tx.Commit()
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func loadAccounts(ctx context.Context, db queryer) ([]auth.Account, error) {
	rows, err := db.QueryContext(ctx, `SELECT name, hash, admin FROM auth_accounts ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var accounts []auth.Account
	for rows.Next() {
		var account auth.Account
		if err := rows.Scan(&account.Name, &account.Hash, &account.Admin); err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, rows.Err()
}

// saveAccounts turns before into after, keeping the rows of accounts that
// stay so they keep their place in the order.
func saveAccounts(ctx context.Context, tx *sql.Tx, before, after []auth.Account) error {
	now := nowText()
	kept := map[string]bool{}
	for _, account := range after {
		if err := auth.ValidateName(account.Name); err != nil {
			return err
		}
		if kept[account.Name] {
			return fmt.Errorf("%w: %s", auth.ErrAccountExists, account.Name)
		}
		kept[account.Name] = true
		if slices.Contains(before, account) {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO auth_accounts (name, hash, admin, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, admin = excluded.admin, updated_at = excluded.updated_at`,
			account.Name, account.Hash, account.Admin, now, now); err != nil {
			return err
		}
	}
	for _, account := range before {
		if kept[account.Name] {
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM auth_accounts WHERE name = ?`, account.Name); err != nil {
			return err
		}
	}
	return nil
}
