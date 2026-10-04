#!/usr/bin/env python3
"""The Updates mod's weekly check: what has a newer upstream, printed as one JSON line.

Read-only. It asks GitHub and npm for the latest versions (gh api GET, npm view)
and runs the person's own updaters in their --check mode. It never installs.

Each item says how it would be updated:
  ready   one or more commands The Tree of Mods runs when the person presses Update
  review  a copy adapted from someone else's repo, or a plugin with no updater:
          Claude compares and merges it with the person, never automatically
  manual  needs the person (a sudo command to copy)
"""

from __future__ import annotations

import concurrent.futures
import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
CLAUDE_PLUGINS = HOME / '.claude/plugins'
CODEX_CACHE = HOME / '.codex/plugins/cache'
CONFIG = HOME / '.claude/updates/sources.json'
TIMEOUT_S = 60
NOTES_CHARS = 700


def load_config() -> dict:
    """What this person checks beyond the defaults (see the README):
    updaters      their own update scripts with a --check mode, and which parser reads each
    adapted       copies of someone else's repo, with where each records the revision it came from
    codexPlugins  Codex plugins built from someone's GitHub releases
    skipMarketplaces / npmSkip   what another updater already covers
    """
    try:
        config = json.loads(CONFIG.read_text())
    except Exception:
        config = {}
    home = lambda path: Path(os.path.expanduser(path))
    config.setdefault('updaterDir', '~/.local/bin')
    config['updaterDir'] = home(config['updaterDir'])
    config.setdefault('updaters', [])
    config.setdefault('codexPlugins', [])
    config.setdefault('skipMarketplaces', ['claude-plugins-official'])
    config.setdefault('npmSkip', [])
    config['adapted'] = [
        {**source, 'pinFile': home(source['pinFile']), 'local': home(source.get('local', ''))}
        for source in config.get('adapted', [])
        if source.get('repo') and source.get('pinFile') and source.get('pinPattern')
    ]
    return config


CONFIG_VALUES = load_config()


def run(argv: list[str], timeout: int = TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb', 'GH_PAGER': '', 'PAGER': 'cat'}
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)


def gh_json(path: str):
    done = run(['gh', 'api', path])
    if done.returncode != 0:
        raise RuntimeError(f'gh api {path}: {done.stderr.strip()[:160]}')
    return json.loads(done.stdout)


def plain(text: str) -> str:
    return re.sub(r'\x1b\[[0-9;]*m', '', text)


def version_key(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r'\d+', text.split('+')[0].split('-')[0]))


def is_newer(latest: str, installed: str) -> bool:
    return version_key(latest) > version_key(installed)


def release_notes(repo: str, installed: str) -> str:
    """The bodies of the releases newer than `installed`, newest first, trimmed."""
    try:
        releases = gh_json(f'repos/{repo}/releases?per_page=5')
    except Exception:
        return ''
    newer = [r for r in releases if not r.get('prerelease') and is_newer(r.get('tag_name', ''), installed)]
    # Each release gets its share, so the oldest new one isn't cut off by the newest.
    share = NOTES_CHARS // max(len(newer), 1)
    return '\n\n'.join(f"{r['tag_name']}: {(r.get('body') or '').strip()[:share]}" for r in newer)


def item(kind: str, id: str, name: str, frm: str, to: str, notes: str = '', **more) -> dict:
    return {'kind': kind, 'id': id, 'name': name, 'from': frm, 'to': to, 'notes': notes[:NOTES_CHARS], **more}


# ---- Claude Code plugins from git marketplaces -------------------------------------------------

def claude_plugins() -> list[dict]:
    installed = json.loads((CLAUDE_PLUGINS / 'installed_plugins.json').read_text())['plugins']
    markets = json.loads((CLAUDE_PLUGINS / 'known_marketplaces.json').read_text())
    settings = json.loads((HOME / '.claude/settings.json').read_text())
    enabled = settings.get('enabledPlugins', {})
    found = []

    for plugin_id, entries in installed.items():
        name, _, market = plugin_id.partition('@')
        source = markets.get(market, {}).get('source', {})
        if market in CONFIG_VALUES['skipMarketplaces'] or enabled.get(plugin_id) is False:
            continue
        repo = source.get('repo') or re.sub(r'^https://github.com/|\.git$', '', source.get('url', ''))
        if '/' not in repo:
            continue

        have = entries[0].get('version', '')
        catalog = json.loads((CLAUDE_PLUGINS / 'marketplaces' / market / '.claude-plugin/marketplace.json').read_text())
        entry = next((p for p in catalog.get('plugins', []) if p.get('name') == name), {})
        sub = entry.get('source', './') if isinstance(entry.get('source'), str) else './'
        manifest_path = os.path.normpath(f'{sub}/.claude-plugin/plugin.json').removeprefix('./')

        try:
            import base64
            blob = gh_json(f'repos/{repo}/contents/{manifest_path}')
            latest = json.loads(base64.b64decode(blob['content'])).get('version', '')
        except Exception:
            continue
        if latest and is_newer(latest, have):
            found.append(item(
                'ready', plugin_id, name, have, latest, release_notes(repo, have),
                apply=[['claude', 'plugin', 'marketplace', 'update', market], ['claude', 'plugin', 'update', '--json', plugin_id]],
                reload=True,
            ))
    return found


# ---- The person's own updaters, in --check mode ------------------------------------------------

def from_updater(script: str, parse) -> list[dict]:
    path = CONFIG_VALUES['updaterDir'] / script
    if not path.exists():
        return []
    done = run([str(path), '--check'], timeout=120)
    return parse(plain(done.stdout + done.stderr), [str(path)])


def parse_impeccable(out: str, apply: list[str]) -> list[dict]:
    found = []
    plugin = re.search(r'plugin: installed (\S+) \((\w+)\), main (\S+) \((\w+)\)', out)
    if plugin and plugin.group(2) != plugin.group(4):
        frm, to = plugin.group(1), plugin.group(3)
        try:
            compare = gh_json(f'repos/pbakaus/impeccable/compare/{plugin.group(2)}...{plugin.group(4)}')
            messages = [c['commit']['message'].split('\n')[0] for c in compare.get('commits', [])]
        except Exception:
            messages = []
        notes = (f'{len(messages)} commits on main, same version number. ' if frm == to else '') + '; '.join(messages[-12:])
        found.append(item('ready', 'impeccable', 'impeccable', frm, to, notes, apply=[apply], reload=True))
    cli = re.search(r'npm CLI: installed (\S+), latest (\S+)', out)
    if cli and cli.group(1) != cli.group(2):
        found.append(item('ready', 'impeccable-cli', 'impeccable CLI', cli.group(1), cli.group(2), apply=[apply]))
    return found


def parse_graft(out: str, apply: list[str]) -> list[dict]:
    m = re.search(r'graft: installed (\S+), latest (\S+?),', out)
    if m and m.group(1) != m.group(2):
        return [item('ready', 'graft', 'graft', m.group(1), m.group(2), apply=[apply])]
    return []


def parse_arrows(out: str, apply: list[str], prefix: str) -> list[dict]:
    """`==> name: 1.2 -> 1.3 available` lines, the shape the updaters share."""
    found = []
    for name, frm, to in re.findall(r'==> ([\w@/.\- ]+?): (\S+) -> (\S+?) available', out):
        if 'sudo' in out.split(f'{name}:')[1].split('\n')[0]:
            continue
        found.append(item('ready', f'{prefix}:{name}', name, frm, to, apply=[apply]))
    return found


def parse_any(out: str, apply: list[str]) -> list[dict]:
    return parse_arrows(out, apply, Path(apply[0]).name)


def parse_agent_reach(out: str, apply: list[str]) -> list[dict]:
    found = parse_arrows(out, apply, 'agent-reach')
    main = re.search(r'main: (\w+)\s+installed: (\w+)', out)
    if main and main.group(1) != main.group(2):
        found.append(item('ready', 'agent-reach', 'Agent Reach', main.group(2)[:7], main.group(1)[:7], apply=[apply]))
    return found


def parse_skills(out: str, apply: list[str]) -> list[dict]:
    found = parse_arrows(out, apply, 'skills')
    for name in re.findall(r'==> ([\w\-]+): update available', out):
        found.append(item('ready', f'skills:{name}', name, '', 'skill', 'The skill changed upstream.', apply=[apply]))
    for name, frm, to, command in re.findall(r'==> ([\w\-]+): (\S+) -> (\S+) available\. Needs sudo[^\n]*\n\s+(.+)', out):
        found.append(item('manual', f'skills:{name}', name, frm, to, command=command.strip()))
    return found


# ---- npm CLIs with no updater of their own ------------------------------------------------------

def npm_globals() -> list[dict]:
    """Every global npm package with a newer release, except linked ones and those another updater covers."""
    listed = json.loads(run(['npm', 'ls', '-g', '--depth=0', '--json']).stdout or '{}').get('dependencies', {})
    outdated = json.loads(run(['npm', 'outdated', '-g', '--json']).stdout or '{}')
    found = []
    for pkg, info in sorted(outdated.items()):
        installed, latest = info.get('current') or '', info.get('latest') or ''
        resolved = (listed.get(pkg) or {}).get('resolved') or ''
        if pkg in CONFIG_VALUES['npmSkip'] or resolved.startswith('file:') or not installed or not is_newer(latest, installed):
            continue
        found.append(item('ready', f'npm:{pkg}', pkg, installed, latest, apply=[['npm', 'i', '-g', f'{pkg}@{latest}']]))
    return found


# ---- Codex plugins of the person's own, built from someone's releases -------------------------

def codex_personal() -> list[dict]:
    found = []
    for entry in CONFIG_VALUES['codexPlugins']:
        name, repo = entry['name'], entry['repo']
        versions = sorted((CODEX_CACHE / entry.get('marketplace', 'personal') / name).glob('*'), key=lambda p: version_key(p.name))
        if not versions:
            continue
        installed = versions[-1].name.split('+')[0]
        try:
            latest = gh_json(f'repos/{repo}/releases/latest')['tag_name'].lstrip('v')
        except Exception:
            continue
        if is_newer(latest, installed):
            found.append(item(
                'review', f'codex:{name}', name, installed, latest, release_notes(repo, installed),
                review=(
                    f"Update my Codex plugin {name} ({entry.get('source', '~/plugins/' + name)}, installed as {name}@{entry.get('marketplace', 'personal')}) "
                    f'from {installed} to {latest} of {repo}. Read the release notes, refresh what the plugin ships '
                    f"from that release, bump its manifest version, and reinstall it with `codex plugin add {name}@{entry.get('marketplace', 'personal')}`. "
                    'Show me the plan before changing files.'
                ),
            ))
    return found


# ---- Copies adapted from someone else's repo ---------------------------------------------------

def adapted(source: dict) -> list[dict]:
    try:
        text = source['pinFile'].read_text()
    except Exception:
        return []
    pin = re.search(source['pinPattern'], text)
    if not pin:
        return []
    pinned = pin.group(1)
    compare = gh_json(f"repos/{source['repo']}/compare/{pinned}...HEAD")
    files = [f['filename'] for f in compare.get('files', [])]
    touched = [f for f in files if not source['paths'] or any(f.startswith(p) for p in source['paths'])]
    if compare.get('ahead_by', 0) == 0 or not touched:
        return []
    head = compare['commits'][-1]['sha'] if compare.get('commits') else 'HEAD'
    messages = [c['commit']['message'].split('\n')[0] for c in compare.get('commits', [])][-12:]
    latest_tag = ''
    try:
        latest_tag = gh_json(f"repos/{source['repo']}/releases/latest")['tag_name']
    except Exception:
        pass
    to = latest_tag or head[:7]
    return [item(
        'review', f"adapted:{source['id']}", source['name'], pinned[:7], to,
        f"{compare['ahead_by']} commits, {len(touched)} files changed. " + '; '.join(reversed(messages)),
        commits=compare['ahead_by'],
        review=(
            f"{source['repo']} moved on from {pinned[:7]} (the revision my adapted copy in {source['local']} came from) "
            f"to {to}: {compare['ahead_by']} commits, {len(touched)} files changed"
            + (f" under {', '.join(source['paths'])}" if source['paths'] else '')
            + '. Compare upstream with my copy, tell me which changes matter for how I use it, and propose a merge '
            f"that keeps my adaptations. Don't change files until I say so; once merged, update the revision recorded in {source['pinFile']}."
        ),
    )]


def main() -> None:
    parsers = {'impeccable': parse_impeccable, 'graft': parse_graft, 'agent-reach': parse_agent_reach, 'skills': parse_skills}
    jobs = {
        'Claude plugins': claude_plugins,
        'npm': npm_globals,
        'Codex plugins': codex_personal,
        **{
            updater['script']: (lambda u=updater: from_updater(u['script'], parsers.get(u.get('parser', ''), parse_any)))
            for updater in CONFIG_VALUES['updaters']
        },
        **{source['name']: (lambda src=source: adapted(src)) for source in CONFIG_VALUES['adapted']},
    }
    items: list[dict] = []
    errors: list[str] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(job): label for label, job in jobs.items()}
        for future in concurrent.futures.as_completed(futures):
            try:
                items.extend(future.result())
            except Exception as error:
                errors.append(f'{futures[future]}: {str(error)[:160]}')

    order = {'ready': 0, 'review': 1, 'manual': 2}
    items.sort(key=lambda found: (order[found['kind']], found['name'].lower()))
    print(json.dumps({
        'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'items': items,
        'errors': sorted(errors),
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': f'{type(error).__name__}: {str(error)[:200]}'}))
        sys.exit(1)
