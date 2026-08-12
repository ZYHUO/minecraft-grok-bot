// gbot — decentralized Minecraft body control for Grok Bots.
// Talks JSONL over a Unix domain socket (no HTTP, no hub).
//
// Usage:
//   gbot spawn -name Andy -soul souls/andy.toml
//   gbot cmd Andy status
//   gbot cmd Andy 'say hello'
//   gbot attach Andy
//   gbot list
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func getenvDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getenvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, syscall.Signal(0)) == nil
}

func rootDir() string {
	exe, err := os.Executable()
	if err == nil {
		// if running from gbot/gbot binary under repo
		dir := filepath.Dir(exe)
		if base := filepath.Base(dir); base == "gbot" || base == "bin" {
			return filepath.Clean(filepath.Join(dir, ".."))
		}
		return dir
	}
	wd, _ := os.Getwd()
	return wd
}

func socketPath(name string) string {
	if p := os.Getenv("GBOT_SOCKET"); p != "" {
		return p
	}
	return filepath.Join(rootDir(), "run", "socks", name+".sock")
}

func pidPath(name string) string {
	return filepath.Join(rootDir(), "run", "pids", name+".pid")
}

func call(name string, req map[string]interface{}) (map[string]interface{}, error) {
	path := socketPath(name)
	conn, err := net.DialTimeout("unix", path, 3*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w (is body running? gbot spawn -name %s)", path, err, name)
	}
	defer conn.Close()
	// Long skills (gather/follow/path) need more than 60s
	deadline := 180 * time.Second
	if op, _ := req["op"].(string); op == "skill" || op == "do" {
		deadline = 300 * time.Second
	}
	_ = conn.SetDeadline(time.Now().Add(deadline))

	if _, ok := req["id"]; !ok {
		req["id"] = time.Now().UnixNano()
	}
	b, _ := json.Marshal(req)
	if _, err := conn.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	rd := bufio.NewReader(conn)
	line, err := rd.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("bad response: %s", string(line))
	}
	return resp, nil
}

func printJSON(v interface{}) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func cmdSpawn(args []string) error {
	fs := flag.NewFlagSet("spawn", flag.ExitOnError)
	name := fs.String("name", "", "bot name (MC username)")
	soul := fs.String("soul", "", "soul profile path")
	host := fs.String("host", getenvDefault("MC_HOST", "127.0.0.1"), "MC host (public name for remote CF tunnel)")
	mcPort := fs.Int("mc-port", getenvInt("MC_PORT", 25565), "MC port")
	mcVersion := fs.String("mc-version", getenvDefault("MC_VERSION", "1.20.1"), "Minecraft protocol version")
	tunnel := fs.String("tunnel", getenvDefault("MC_TUNNEL", "auto"), "Modflared tunnel: auto|on|off")
	tunnelHost := fs.String("tunnel-host", os.Getenv("MC_TUNNEL_HOST"), "force CF access hostname (skip TXT)")
	httpPort := fs.Int("http-port", 0, "legacy HTTP (0=off)")
	noModes := fs.Bool("no-modes", false, "disable autonomous modes")
	clientID := fs.String("client-id", "", "override GrokBotGate client_id (default: soul)")
	tokenURL := fs.String("token-url", os.Getenv("GROK_TOKEN_URL"), "OAuth token URL")
	audience := fs.String("audience", os.Getenv("GROK_MC_AUDIENCE"), "JWT audience")
	_ = fs.Parse(args)
	if *name == "" {
		return fmt.Errorf("spawn requires -name")
	}
	root := rootDir()
	sock := socketPath(*name)
	_ = os.MkdirAll(filepath.Dir(sock), 0o755)
	_ = os.MkdirAll(filepath.Dir(pidPath(*name)), 0o755)
	_ = os.MkdirAll(filepath.Join(root, "logs"), 0o755)

	if b, err := os.ReadFile(pidPath(*name)); err == nil {
		pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		if processAlive(pid) {
			return fmt.Errorf("%s already running (pid %d). gbot stop %s first", *name, pid, *name)
		}
	}
	if _, err := os.Stat(sock); err == nil {
		if _, err := call(*name, map[string]interface{}{"op": "health"}); err == nil {
			return fmt.Errorf("%s already healthy at %s. gbot stop %s first", *name, sock, *name)
		}
	}

	if *soul == "" {
		*soul = filepath.Join(root, "souls", "andy.toml")
	}
	if !filepath.IsAbs(*soul) {
		*soul = filepath.Join(root, *soul)
	}

	node := filepath.Join(root, "player-bot", "player-bot.js")
	argv := []string{
		node,
		"--name", *name,
		"--socket", sock,
		"--soul", *soul,
		"--host", *host,
		"--mc-port", strconv.Itoa(*mcPort),
		"--version", *mcVersion,
		"--tunnel", *tunnel,
	}
	if *tunnelHost != "" {
		argv = append(argv, "--tunnel-host", *tunnelHost)
	}
	if *httpPort > 0 {
		argv = append(argv, "--http-port", strconv.Itoa(*httpPort))
	}
	if *noModes {
		argv = append(argv, "--no-modes")
	}

	logFile := filepath.Join(root, "logs", "player-"+*name+".log")
	lf, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	cmd := exec.Command("node", argv...)
	cmd.Stdout = lf
	cmd.Stderr = lf
	cmd.Dir = filepath.Join(root, "player-bot")
	env := append([]string{}, os.Environ()...)
	if *clientID != "" {
		env = append(env, "GROK_CLIENT_ID="+*clientID)
	}
	if *tokenURL != "" {
		env = append(env, "GROK_TOKEN_URL="+*tokenURL)
	}
	if *audience != "" {
		env = append(env, "GROK_MC_AUDIENCE="+*audience)
	}
	if *mcVersion != "" {
		env = append(env, "MC_VERSION="+*mcVersion)
	}
	env = append(env, "BOT_NAME="+*name)
	cmd.Env = env
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = os.WriteFile(pidPath(*name), []byte(strconv.Itoa(cmd.Process.Pid)), 0o644)
	fmt.Printf("spawned %s pid=%d\n  socket: %s\n  soul:   %s\n  log:    %s\n", *name, cmd.Process.Pid, sock, *soul, logFile)
	// wait briefly for socket
	for i := 0; i < 30; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}

func cmdStop(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("stop <name>")
	}
	name := args[0]
	resp, err := call(name, map[string]interface{}{"op": "quit"})
	if err != nil {
		// fallback kill pid
		b, e := os.ReadFile(pidPath(name))
		if e == nil {
			pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
			if pid > 0 {
				p, _ := os.FindProcess(pid)
				_ = p.Kill()
				fmt.Println("killed pid", pid)
			}
		}
		return err
	}
	printJSON(resp)
	_ = os.Remove(pidPath(name))
	return nil
}

func cmdList(args []string) error {
	dir := filepath.Join(rootDir(), "run", "socks")
	entries, err := os.ReadDir(dir)
	if err != nil {
		fmt.Println("(no sockets yet)")
		return nil
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sock") {
			name := strings.TrimSuffix(e.Name(), ".sock")
			resp, err := call(name, map[string]interface{}{"op": "health"})
			if err != nil {
				fmt.Printf("%-16s  offline (%v)\n", name, err)
				continue
			}
			r, _ := resp["result"].(map[string]interface{})
			fmt.Printf("%-16s  connected=%v  job=%v\n", name, r["connected"], r["job"])
		}
	}
	return nil
}

func parseDoLine(s string) map[string]interface{} {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	// raw json
	if strings.HasPrefix(s, "{") {
		var m map[string]interface{}
		if json.Unmarshal([]byte(s), &m) == nil {
			if _, ok := m["op"]; !ok {
				m["op"] = "do"
			}
			return m
		}
	}
	parts := strings.Fields(s)
	if len(parts) == 0 {
		return nil
	}
	switch parts[0] {
	case "status", "health", "job", "events", "soul", "modes", "stop", "quit", "ping", "auth-status", "auth_status", "auth":
		op := parts[0]
		if op == "auth-status" {
			op = "auth_status"
		}
		m := map[string]interface{}{"op": op}
		if parts[0] == "events" && len(parts) > 1 {
			if n, err := strconv.Atoi(parts[1]); err == nil {
				m["since"] = n
			}
		}
		return m
	case "say":
		return map[string]interface{}{"op": "say", "text": strings.Join(parts[1:], " ")}
	case "goal":
		return map[string]interface{}{"op": "goal", "text": strings.Join(parts[1:], " ")}
	case "skill", "sk":
		if len(parts) < 2 {
			return map[string]interface{}{"op": "skill", "skill": "help"}
		}
		m := map[string]interface{}{"op": "skill", "skill": parts[1]}
		sk := parts[1]
		unescape := func(s string) string {
			s = strings.ReplaceAll(s, `\n`, "\n")
			s = strings.ReplaceAll(s, `\t`, "\t")
			return s
		}
		switch sk {
		case "gather", "collect", "collect_blocks":
			if len(parts) > 2 {
				m["block"] = parts[2]
			}
			if len(parts) > 3 {
				if n, err := strconv.Atoi(parts[3]); err == nil {
					m["count"] = n
				}
			}
		case "goto", "go", "come", "go_to_coordinates":
			if len(parts) >= 5 {
				x, _ := strconv.ParseFloat(parts[2], 64)
				y, _ := strconv.ParseFloat(parts[3], 64)
				z, _ := strconv.ParseFloat(parts[4], 64)
				m["x"], m["y"], m["z"] = x, y, z
			}
		case "follow", "follow_player":
			if len(parts) > 2 {
				m["player"] = parts[2]
			}
			if len(parts) > 3 {
				if n, err := strconv.Atoi(parts[3]); err == nil {
					m["duration_ms"] = n
				}
			}
		case "give", "give_player":
			if len(parts) > 2 {
				m["player"] = parts[2]
			}
			if len(parts) > 3 {
				m["item"] = parts[3]
			}
			if len(parts) > 4 {
				if n, err := strconv.Atoi(parts[4]); err == nil {
					m["count"] = n
				}
			}
		case "go_to_player", "look_player", "go_find", "find", "find_player":
			if len(parts) > 2 {
				m["player"] = parts[2]
			}
			if len(parts) >= 6 {
				x, _ := strconv.ParseFloat(parts[3], 64)
				y, _ := strconv.ParseFloat(parts[4], 64)
				z, _ := strconv.ParseFloat(parts[5], 64)
				m["x"], m["y"], m["z"] = x, y, z
			}
		case "write_sign", "say":
			m["text"] = unescape(strings.Join(parts[2:], " "))
		case "write_book":
			// skill write_book [title] -- rest is body; if first token has no spaces use as title
			rest := parts[2:]
			if len(rest) >= 2 && !strings.Contains(rest[0], " ") {
				m["title"] = rest[0]
				m["text"] = unescape(strings.Join(rest[1:], " "))
			} else {
				m["title"] = "Note"
				m["text"] = unescape(strings.Join(rest, " "))
			}
		case "remember_here", "remember", "go_place", "go_to_place":
			if len(parts) > 2 {
				m["name"] = parts[2]
			}
		case "dig_down":
			if len(parts) > 2 {
				if n, err := strconv.Atoi(parts[2]); err == nil {
					m["depth"] = n
					m["distance"] = n
				}
			}
		case "stay":
			if len(parts) > 2 {
				if n, err := strconv.Atoi(parts[2]); err == nil {
					m["seconds"] = n
				}
			}
		case "put_chest", "take_chest", "equip", "discard", "consume", "craft", "place_here":
			if len(parts) > 2 {
				m["item"] = parts[2]
			}
			if len(parts) > 3 {
				if n, err := strconv.Atoi(parts[3]); err == nil {
					m["count"] = n
				} else {
					m["block"] = parts[3]
				}
			}
		case "go_to_block", "attack":
			if len(parts) > 2 {
				m["name"] = parts[2]
				m["block"] = parts[2]
			}
		case "read_sign", "find_signs":
			if len(parts) >= 5 {
				x, _ := strconv.ParseFloat(parts[2], 64)
				y, _ := strconv.ParseFloat(parts[3], 64)
				z, _ := strconv.ParseFloat(parts[4], 64)
				m["x"], m["y"], m["z"] = x, y, z
			} else if len(parts) > 2 {
				if n, err := strconv.Atoi(parts[2]); err == nil {
					m["range"] = n
				}
			}
		case "smelt", "smelt_item", "craft_plan":
			if len(parts) > 2 {
				m["item"] = parts[2]
			}
			if len(parts) > 3 {
				if n, err := strconv.Atoi(parts[3]); err == nil {
					m["count"] = n
				}
			}
		case "use_on", "useon":
			if len(parts) > 2 {
				m["tool"] = parts[2]
			}
			if len(parts) > 3 {
				m["target"] = parts[3]
			}
		case "till":
			if len(parts) >= 5 {
				x, _ := strconv.ParseFloat(parts[2], 64)
				y, _ := strconv.ParseFloat(parts[3], 64)
				z, _ := strconv.ParseFloat(parts[4], 64)
				m["x"], m["y"], m["z"] = x, y, z
			}
		case "plant":
			if len(parts) > 2 {
				m["seed"] = parts[2]
			}
		case "harvest", "go_to_entity":
			if len(parts) > 2 {
				m["name"] = parts[2]
			}
		case "villager_trades":
			if len(parts) > 2 {
				if n, err := strconv.Atoi(parts[2]); err == nil {
					m["id"] = n
				}
			}
		case "trade":
			if len(parts) > 2 {
				if n, err := strconv.Atoi(parts[2]); err == nil {
					m["id"] = n
				}
			}
			if len(parts) > 3 {
				if n, err := strconv.Atoi(parts[3]); err == nil {
					m["index"] = n
				}
			}
			if len(parts) > 4 {
				if n, err := strconv.Atoi(parts[4]); err == nil {
					m["count"] = n
				}
			}
		case "whisper":
			if len(parts) > 2 {
				m["player"] = parts[2]
			}
			m["text"] = unescape(strings.Join(parts[3:], " "))
		case "shout_trade":
			if len(parts) > 2 {
				m["need"] = parts[2]
			}
			if len(parts) > 3 {
				m["give"] = parts[3]
			}
			if len(parts) > 4 {
				if n, err := strconv.Atoi(parts[4]); err == nil {
					m["count"] = n
				}
			}
		case "shout_need", "shout_have":
			if len(parts) > 2 {
				m["item"] = parts[2]
			}
			if len(parts) > 3 {
				if n, err := strconv.Atoi(parts[3]); err == nil {
					m["count"] = n
				}
			}
		case "shout_help", "shout_meet", "shout_here", "bulletin":
			m["text"] = unescape(strings.Join(parts[2:], " "))
			if sk == "bulletin" && len(parts) > 2 && !strings.Contains(parts[2], " ") {
				m["tag"] = parts[2]
				m["text"] = unescape(strings.Join(parts[3:], " "))
			}
		case "mail", "write_mail":
			if len(parts) > 2 {
				m["to"] = parts[2]
			}
			m["text"] = unescape(strings.Join(parts[3:], " "))
		case "forget_place":
			if len(parts) > 2 {
				m["name"] = parts[2]
			}
		case "emote":
			if len(parts) > 2 {
				m["kind"] = parts[2]
			}
			if len(parts) > 3 {
				m["player"] = parts[3]
			}
		case "wave", "point":
			if len(parts) > 2 {
				m["player"] = parts[2]
				m["text"] = unescape(strings.Join(parts[2:], " "))
			}
		default:
			if len(parts) > 2 {
				m["text"] = unescape(strings.Join(parts[2:], " "))
			}
		}
		return m
	case "skills", "help-skills":
		return map[string]interface{}{"op": "skills"}
	case "go", "move":
		// go x y z
		if len(parts) < 4 {
			return map[string]interface{}{"op": "do", "type": "chat", "message": "usage: go x y z"}
		}
		x, _ := strconv.ParseFloat(parts[1], 64)
		y, _ := strconv.ParseFloat(parts[2], 64)
		z, _ := strconv.ParseFloat(parts[3], 64)
		return map[string]interface{}{"op": "do", "type": "move_to", "x": x, "y": y, "z": z}
	case "dig":
		if len(parts) >= 4 {
			x, _ := strconv.ParseFloat(parts[1], 64)
			y, _ := strconv.ParseFloat(parts[2], 64)
			z, _ := strconv.ParseFloat(parts[3], 64)
			return map[string]interface{}{"op": "do", "type": "dig", "x": x, "y": y, "z": z}
		}
		if len(parts) >= 2 {
			return map[string]interface{}{"op": "do", "type": "dig", "block": parts[1]}
		}
	case "do":
		// do move_to ... not parsed; expect json
		return map[string]interface{}{"op": "do", "type": "chat", "message": "use: do {json} or go/dig/say"}
	default:
		// treat as public chat
		return map[string]interface{}{"op": "say", "text": s}
	}
	return nil
}

func cmdCmd(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("cmd <name> <command...>")
	}
	name := args[0]
	line := strings.Join(args[1:], " ")
	req := parseDoLine(line)
	if req == nil {
		return fmt.Errorf("empty command")
	}
	resp, err := call(name, req)
	if err != nil {
		return err
	}
	printJSON(resp)
	if ok, _ := resp["ok"].(bool); !ok {
		return fmt.Errorf("op failed: %v", resp["message"])
	}
	return nil
}

func cmdAttach(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("attach <name>")
	}
	name := args[0]
	fmt.Printf("attached to %s  (socket %s)\n", name, socketPath(name))
	fmt.Println("commands: status | events | go x y z | dig oak_log | say ...")
	fmt.Println("  skill help | skill gather oak_log 8 | skill write_sign line1\\nline2")
	fmt.Println("  skill remember_here home | skill go_place home | skill view_chest")
	fmt.Println("  skill write_book hello | skill put_chest cobblestone 32 | goal ... | stop")
	fmt.Println("  auth-status | skill go_find NAME")
	fmt.Println("empty line / ctrl+D to exit attach (body keeps running)")
	sc := bufio.NewScanner(os.Stdin)
	for {
		fmt.Printf("%s> ", name)
		if !sc.Scan() {
			break
		}
		line := strings.TrimSpace(sc.Text())
		if line == "" || line == "exit" || line == ".q" {
			if line == "exit" || line == ".q" {
				break
			}
			continue
		}
		req := parseDoLine(line)
		if req == nil {
			continue
		}
		resp, err := call(name, req)
		if err != nil {
			fmt.Println("err:", err)
			continue
		}
		printJSON(resp)
	}
	return sc.Err()
}

func usage() {
	fmt.Print(`gbot — decentralized body control (Unix socket JSONL, no hub)

  gbot spawn -name Andy [-soul souls/andy.toml] [-host 127.0.0.1] [-mc-port 25565] [-mc-version 1.20.1]
  gbot spawn -name Andy -host play.example.net -tunnel auto
  gbot cmd Andy auth-status
  gbot stop Andy
  gbot list
  gbot cmd Andy status
  gbot cmd Andy 'say 有人一起挖矿吗'
  gbot cmd Andy 'go 10 64 0'
  gbot attach Andy

Env:
  GBOT_SOCKET          override socket path
  MC_HOST / MC_PORT    default spawn target
  MC_VERSION           protocol (default 1.20.1)
  MC_TUNNEL            auto|on|off (Modflared client; default auto)
  MC_TUNNEL_HOST       force CF access hostname (skip DNS TXT)
  GROK_TOKEN_URL       OAuth token endpoint
  GROK_CLIENT_SECRET   per-bot secret (never pass on CLI)
  GROK_MC_AUDIENCE     JWT aud (default mc-paper-1.20.1)
`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(0)
	}
	var err error
	switch os.Args[1] {
	case "spawn":
		err = cmdSpawn(os.Args[2:])
	case "stop":
		err = cmdStop(os.Args[2:])
	case "list":
		err = cmdList(os.Args[2:])
	case "cmd":
		err = cmdCmd(os.Args[2:])
	case "attach":
		err = cmdAttach(os.Args[2:])
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
