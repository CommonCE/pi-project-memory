#!/usr/bin/env python3
"""Linux PTY acceptance test using real Pi TUI and a network-free local provider.

Usage: python test/tui-smoke.py --host /absolute/path/to/pi-coding-agent/package.json
Only Python stdlib is used; no user's settings, credentials or memory are loaded.
"""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='pi-memory-tui-test-') as tmp:
        base = Path(tmp)
        root, agent, home = (base / name for name in ('repo', 'agent', 'home'))
        for directory in (root, agent, home):
            directory.mkdir()
        (agent / 'settings.json').write_text(json.dumps({
            'enableAnalytics': False, 'enableInstallTelemetry': False,
            'compaction': {'enabled': False, 'reserveTokens': 1024, 'keepRecentTokens': 0},
        }))
        (base / 'config.json').write_text('{}')
        env = {
            'PATH': os.environ['PATH'], 'HOME': str(home), 'LANG': 'C.UTF-8',
            'TERM': 'xterm-256color', 'PI_OFFLINE': '1',
            'PI_CODING_AGENT_DIR': str(agent),
            'PI_PROJECT_MEMORY_HOME': str(base / 'vault'),
            'PI_PROJECT_MEMORY_CONFIG': str(base / 'config.json'),
            'PI_MEMORY_TEST_CALLS': str(base / 'calls.jsonl'),
        }
        command = [
            'node', str(args.host.parent / 'dist/cli.js'), '--offline', '--no-session',
            '--no-extensions', '--no-skills', '--no-prompt-templates',
            '--no-context-files', '--no-themes', '--no-mcp', '--approve',
            '--provider', 'memory-offline-test', '--model', 'offline', '--thinking', 'off',
            '--tools', 'project_memory_search,project_memory_save', '--tui-mode', 'regular',
            '--extension', str(repo / 'test/fixtures/offline-provider.ts'),
            '--extension', str(repo / 'index.ts'),
        ]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        process = subprocess.Popen(command, cwd=root, env=env, stdin=slave,
                                   stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()

        def drain(timeout=0.05):
            if select.select([master], [], [], timeout)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                output.extend(data)
                if len(output) > 128000:
                    del output[:-128000]

        def wait_for(predicate, label):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                drain()
                if predicate():
                    return
                if process.poll() is not None:
                    raise RuntimeError(f'Pi exited before {label}: {process.returncode}')
            raise RuntimeError(f'TUI deadline waiting for {label}')

        def send(text):
            os.write(master, (text + '\r').encode('utf-8'))

        try:
            # Wait for the interactive editor rather than sending input during startup.
            wait_for(lambda: b'memory: NO-MEMORY' in output,
                     'interactive startup')
            send('/memory-init TUI项目')
            config = root / '.pi/project-memory.json'
            wait_for(config.exists, 'explicit initialization')
            assert json.loads(config.read_text())['name'] == 'TUI项目'
            pack = root / 'pi-memory/packs/tui项目'
            # slug() lowercases Latin characters, while the display name stays unchanged.
            assert pack.is_dir()
            send('核实发布流程')
            candidates = pack / '00-system/pi-agent/.learning/candidates'
            wait_for(lambda: candidates.is_dir() and len(list(candidates.glob('*.json'))) == 1,
                     'post-turn candidate')
            candidate = json.loads(next(candidates.glob('*.json')).read_text())
            send('/memory review')
            wait_for(lambda: candidate['id'].encode() in output, 'review output')
            send('/memory review approve ' + candidate['id'][:12])
            wait_for(lambda: len(list((pack / '70-runbooks').glob('*.md'))) == 1,
                     'approved note')
            send('/compact')
            wait_for(lambda: len(list((pack / '80-sessions').glob('*.md'))) == 1,
                     'pre-compaction handoff')
            # Pi renders successful compaction collapsed by default, not the summary body.
            wait_for(lambda: b'Compacted from' in output,
                     'native compaction completion')
            def calls():
                return [json.loads(line) for line in (base / 'calls.jsonl').read_text().splitlines()]

            assert sum(call['kind'] == 'curator' for call in calls()) == 1
            assert any(call['kind'] == 'compact' for call in calls())
            output.clear()
            send('/memory learn off')
            wait_for(lambda: b'Learning: off' in output, 'learning override')
            before = sum(call['kind'] == 'assistant' for call in calls())
            send('关闭学习后验证发布流程')
            wait_for(lambda: sum(call['kind'] == 'assistant' for call in calls()) > before,
                     'turn with learning disabled')
            for _ in range(10):
                drain()
            assert sum(call['kind'] == 'curator' for call in calls()) == 1
            output.clear()
            send('/reload')
            wait_for(lambda: b'reloaded' in output.lower(), 'resource reload')
            output.clear()
            send('/memory status')
            wait_for(lambda: b'Learning: suggest' in output, 'learning reset after reload')
            send('重载后验证发布流程')
            wait_for(lambda: sum(call['kind'] == 'curator' for call in calls()) == 2,
                     'learning after reload')
            print(json.dumps({'mode': 'real-tui-pty', 'init': True, 'learning': True,
                              'review': True, 'approval': True, 'handoff': True,
                              'nativeCompaction': True, 'reload': True,
                              'learningOverrideReset': True, 'curatorCalls': 2,
                              'remoteModelCalls': 0}, ensure_ascii=False))
        except Exception:
            print(output.decode('utf-8', errors='replace')[-4000:])
            raise
        finally:
            # No user process is touched; signal only the test child's process group.
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            os.close(master)


if __name__ == '__main__':
    main()
