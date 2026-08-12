//go:build !pack

package main

func packed() bool { return false }

func packedHome() string { return "" }

func ensurePackedHome() (string, error) { return "", nil }

func nodeExecutable() string {
	if n := getenvDefault("NODE_BIN", ""); n != "" {
		return n
	}
	return "node"
}
