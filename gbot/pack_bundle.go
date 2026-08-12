//go:build pack

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var _ embed.FS

//go:embed bundle.tar.gz
var packedBundle []byte

func packed() bool { return true }

func packedHome() string {
	if d := os.Getenv("GBOT_HOME"); d != "" {
		return d
	}
	cache, err := os.UserCacheDir()
	if err != nil || cache == "" {
		cache = os.TempDir()
	}
	return filepath.Join(cache, "minecraft-grok-bot", packVersion)
}

func ensurePackedHome() (string, error) {
	home := packedHome()
	stamp := filepath.Join(home, ".bundle-ok")
	if b, err := os.ReadFile(stamp); err == nil && strings.TrimSpace(string(b)) == packVersion {
		if _, err := os.Stat(filepath.Join(home, "player-bot", "player-bot.js")); err == nil {
			return home, nil
		}
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return "", err
	}
	tmp := home + ".extracting"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return "", err
	}
	if err := extractTarGz(packedBundle, tmp); err != nil {
		_ = os.RemoveAll(tmp)
		return "", fmt.Errorf("extract bundle: %w", err)
	}
	node := filepath.Join(tmp, "bin", "node")
	_ = os.Chmod(node, 0o755)
	_ = os.WriteFile(filepath.Join(tmp, ".bundle-ok"), []byte(packVersion+"\n"), 0o644)
	_ = os.RemoveAll(home)
	if err := os.Rename(tmp, home); err != nil {
		return "", err
	}
	return home, nil
}

func nodeExecutable() string {
	if n := getenvDefault("NODE_BIN", ""); n != "" {
		return n
	}
	return filepath.Join(packedHome(), "bin", "node")
}

func extractTarGz(raw []byte, dest string) error {
	gr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	defer gr.Close()
	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(hdr.Name)
		if name == "." || name == "" {
			continue
		}
		if strings.HasPrefix(name, "..") || strings.Contains(name, ":") {
			return fmt.Errorf("refusing path %q", hdr.Name)
		}
		target := filepath.Join(dest, name)
		if !strings.HasPrefix(target, dest+string(os.PathSeparator)) && target != dest {
			return fmt.Errorf("refusing path %q", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, hdr.FileInfo().Mode().Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		}
	}
}
