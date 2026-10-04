#!/usr/bin/env python3
"""What The Tree of Mods shows, as one JSON line.

Usage:
  inventory.py            the mods, plugins, updates and GitHub numbers; tests from the cache
  inventory.py --tests    also re-runs the tests of mods whose files changed since their last run
  inventory.py toggle <mod dir> on|off
                          adds or removes a mod of yours in CLAUDE_CODE_PLUGIN_DIRS (settings backed up first)
  inventory.py apply <item id>... | all
                          runs those updates' steps from the Updates mod's report, then checks again

Reads ~/.claude settings and plugin files, the mods folder and its git state, and
GitHub's traffic numbers for the repo (gh api GET). Writes only its own cache, and
settings.json on a toggle.
"""

from __future__ import annotations

import concurrent.futures
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
CACHE = HOME / '.claude/tree-of-mods'


def where() -> tuple[Path, Path | None, str | None]:
    """The folder of mods you make, the repo it sits in and its GitHub owner/name.

    From ~/.claude/tree-of-mods/config.json ({"modsDir": ..., "repo": "owner/name"}) when set;
    otherwise the folder this mod sits in, and the GitHub remote of its repository.
    """
    config = read_json(CACHE / 'config.json', {})
    mods = Path(os.path.expanduser(config['modsDir'])) if config.get('modsDir') else Path(__file__).resolve().parents[2]
    top = subprocess.run(['git', '-C', str(mods), 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    repo_dir = Path(top.stdout.strip()) if top.returncode == 0 else None
    repo = config.get('repo')
    if not repo and repo_dir is not None:
        remote = subprocess.run(['git', '-C', str(repo_dir), 'remote', 'get-url', 'origin'], capture_output=True, text=True).stdout.strip()
        found = re.search(r'github\.com[:/]([^/]+/[^/.]+)', remote)
        repo = found.group(1) if found else None
    return mods, repo_dir, repo
SETTINGS = HOME / '.claude/settings.json'
PLUGINS = HOME / '.claude/plugins'
STORE = PLUGINS / 'store'
STATS_TTL_S = 3600


def run(argv: list[str], timeout: int = 60, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, 'NO_COLOR': '1', 'GH_PAGER': ''}
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def store_of(plugin: str) -> dict:
    """A plugin's Claude Code store, the newest when there are several."""
    files = sorted(glob.glob(str(STORE / f'{plugin}_*.json')), key=os.path.getmtime)
    return read_json(Path(files[-1]), {}) if files else {}


def plugin_dirs() -> list[str]:
    value = read_json(SETTINGS, {}).get('env', {}).get('CLAUDE_CODE_PLUGIN_DIRS', '')
    return [part for part in value.split(':') if part]


def pretty(name: str) -> str:
    return name.replace('-', ' ').capitalize()


# ---- What each mod of yours has done, from its own store ---------------------------------------

def plural(n: int, one: str, many: str) -> str:
    return f'{n} {one if n == 1 else many}'


def usage(name: str) -> str | None:
    data = store_of(name)
    if name == 'bouncer':
        return plural(len(data.get('seen') or []), 'link judged', 'links judged')
    if name == 'updates':
        report = latest_report()
        ready = [item for item in report.get('items', []) if item.get('kind') == 'ready']
        return plural(len(ready), 'update found', 'updates found') if report else 'No check yet'
    if name == 'grudge':
        return plural(len(data.get('ledger') or []), 'rule', 'rules') + ' yet' * (len(data.get('ledger') or []) == 0)
    if name == 'third-eye':
        taste = data.get('taste') or {}
        return plural(len(taste.get('asked') or []), 'idea taken', 'ideas taken')
    return None


# ---- Tests, cached by the newest file in the mod -----------------------------------------------

def newest(mod: Path) -> float:
    stamps = [p.stat().st_mtime for p in mod.rglob('*') if p.is_file() and '.claude-plugin/types' not in str(p)]
    return max(stamps, default=0.0)


def test_mod(mod: Path) -> dict:
    done = run(['claude', 'plugin', 'test', str(mod)], timeout=300)
    out = done.stdout + done.stderr
    passed = re.search(r'(\d+) pass', out)
    failed = re.search(r'(\d+) fail', out)
    return {'pass': int(passed.group(1)) if passed else 0, 'fail': int(failed.group(1)) if failed else (0 if passed else 1), 'at': newest(mod)}


def tests(mods: list[Path], refresh: bool) -> dict:
    cache = read_json(CACHE / 'tests.json', {})
    stale = [mod for mod in mods if (mod / 'tests').is_dir() and cache.get(mod.name, {}).get('at') != newest(mod)]
    if refresh and stale:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            for mod, result in zip(stale, pool.map(test_mod, stale)):
                cache[mod.name] = result
        CACHE.mkdir(parents=True, exist_ok=True)
        (CACHE / 'tests.json').write_text(json.dumps(cache))
    return {name: {**value, 'stale': any(mod.name == name for mod in stale) and not refresh} for name, value in cache.items()}


# ---- Your mods ---------------------------------------------------------------------------------

def yours(refresh: bool) -> list[dict]:
    mods = sorted(p for p in MODS.iterdir() if (p / '.claude-plugin/plugin.json').exists()) if MODS.is_dir() else []
    listed = {entry.get('name') for entry in read_json(REPO / '.claude-plugin/marketplace.json', {}).get('plugins', [])} if REPO else set()
    tracked = set(run(['git', 'ls-files', str(MODS.relative_to(REPO))], cwd=REPO).stdout.split('\n')) if REPO else set()
    enabled = set(plugin_dirs())
    results = tests(mods, refresh)
    found = []
    for mod in mods:
        manifest = read_json(mod / '.claude-plugin/plugin.json', {})
        name = manifest.get('name', mod.name)
        found.append({
            'id': mod.name,
            'name': manifest.get('displayName') or pretty(name),
            'version': manifest.get('version', ''),
            'description': manifest.get('description', ''),
            'dir': str(mod),
            'isPublished': REPO is not None and name in listed and str((mod / '.claude-plugin/plugin.json').relative_to(REPO)) in tracked,
            'isOn': str(mod) in enabled,
            'usage': usage(name),
            'tests': results.get(mod.name),
        })
    return found


# ---- Plugins installed from marketplaces -------------------------------------------------------

def installed() -> list[dict]:
    plugins = read_json(PLUGINS / 'installed_plugins.json', {}).get('plugins', {})
    enabled = read_json(SETTINGS, {}).get('enabledPlugins', {})
    report = latest_report()
    ready = {item['id']: item['to'] for item in report.get('items', []) if item.get('kind') == 'ready'}
    found = []
    for plugin_id, entries in sorted(plugins.items()):
        name, _, market = plugin_id.partition('@')
        found.append({
            'id': plugin_id,
            'name': name,
            'market': market,
            'version': (entries[0] if entries else {}).get('version', ''),
            'isOn': enabled.get(plugin_id) is not False,
            'update': ready.get(plugin_id) or ready.get(name),
        })
    return found


def latest_report() -> dict:
    """The Updates mod's report, or this panel's own recheck after an update, whichever is newer."""
    stored = store_of('updates').get('report') or {}
    rechecked = read_json(CACHE / 'updates.json', {})
    return max([stored, rechecked], key=lambda report: report.get('checkedAt', ''))


def updates() -> list[dict]:
    keep = ('kind', 'id', 'name', 'from', 'to', 'line', 'review', 'command', 'reload', 'commits')
    return [{key: item[key] for key in keep if key in item} for item in latest_report().get('items', [])]


def updates_checker() -> Path | None:
    """The Updates mod's checker: among your mods, the plugin folders in your settings, or the plugin cache."""
    candidates = [MODS / 'updates', *map(Path, plugin_dirs()), *Path(PLUGINS / 'cache').glob('*/updates/*')]
    for folder in candidates:
        if read_json(folder / '.claude-plugin/plugin.json', {}).get('name') == 'updates' and (folder / 'bin/check.py').exists():
            return folder / 'bin/check.py'
    return None


def apply(ids: list[str]) -> None:
    """Runs the steps of the chosen ready items, each step once, then checks again."""
    report = latest_report()
    chosen = [item for item in report.get('items', []) if item.get('kind') == 'ready' and ('all' in ids or item['id'] in ids)]
    failed: dict[str, str] = {}
    ran: dict[str, str | None] = {}
    for item in chosen:
        for step in item.get('apply') or []:
            key = json.dumps(step)
            if key not in ran:
                try:
                    done = subprocess.run(step, capture_output=True, text=True, timeout=240)
                    if done.returncode == 0:
                        ran[key] = None
                    elif step[0] == 'claude' and 'shownCommand' in done.stdout:
                        ran[key] = f'Asks you to confirm a command: run claude plugin update {step[-1]} in a terminal'
                    else:
                        lines = [l.strip() for l in (done.stderr + '\n' + done.stdout).split('\n') if l.strip()]
                        said = next((l for l in lines if re.search(r'error|fail|refus|denied|not found', l, re.I)), lines[-1] if lines else f'exit {done.returncode}')
                        ran[key] = re.sub(r'\x1b\[[0-9;]*m', '', said)[:140]
                except Exception as error:
                    ran[key] = str(error)[:140]
            if ran[key] is not None:
                failed[item['id']] = ran[key]
                break
    done_ids = [item['id'] for item in chosen if item['id'] not in failed]
    # Check again, keeping the summaries the Updates mod wrote.
    checker = updates_checker()
    if checker is None:
        print(json.dumps({'done': [], 'failed': {i: 'The Updates mod is not installed' for i in ids}, 'reload': False}))
        return
    lines = {item['id']: item.get('line') for item in report.get('items', []) if item.get('line')}
    try:
        fresh = json.loads(run(['python3', str(checker)], timeout=300).stdout.strip().split('\n')[-1])
        if 'items' in fresh:
            for item in fresh['items']:
                if item['id'] in lines:
                    item['line'] = lines[item['id']]
            CACHE.mkdir(parents=True, exist_ok=True)
            (CACHE / 'updates.json').write_text(json.dumps(fresh))
    except Exception:
        pass
    reload = any(item.get('reload') for item in chosen if item['id'] in done_ids)
    print(json.dumps({'done': done_ids, 'failed': failed, 'reload': reload}))


# ---- GitHub's numbers for the repo, cached for an hour -----------------------------------------

def stats() -> dict:
    if not OWNER_REPO:
        return {'error': 'no GitHub repo found for your mods folder'}
    cached = read_json(CACHE / 'stats.json', {})
    if cached.get('version') == 2 and time.time() - cached.get('at', 0) < STATS_TTL_S:
        return cached

    def get(path: str) -> dict:
        done = run(['gh', 'api', path])
        if done.returncode != 0:
            raise RuntimeError(done.stderr.strip()[:120])
        return json.loads(done.stdout)

    try:
        clones = get(f'repos/{OWNER_REPO}/traffic/clones')
        views = get(f'repos/{OWNER_REPO}/traffic/views')
        repo = get(f'repos/{OWNER_REPO}')
        paths = get(f'repos/{OWNER_REPO}/traffic/popular/paths')
        # GitHub keeps the 10 most viewed pages of the last 14 days; a mod's are those under its folder.
        mod_views: dict[str, int] = {}
        for entry in paths if isinstance(paths, list) else []:
            found = re.search(r'/mods/([^/]+)', entry.get('path', ''))
            if found:
                mod_views[found.group(1)] = mod_views.get(found.group(1), 0) + entry.get('count', 0)
        fresh = {
            'version': 2,
            'at': time.time(),
            'cloners': clones.get('uniques', 0),
            'clones': clones.get('count', 0),
            'daily': [day.get('count', 0) for day in clones.get('clones', [])][-14:],
            'peak': max(clones.get('clones', []), key=lambda day: day.get('count', 0), default={}).get('timestamp', '')[:10],
            'visitors': views.get('uniques', 0),
            'stars': repo.get('stargazers_count', 0),
            'modViews': mod_views,
        }
    except Exception as error:
        return {**cached, 'error': str(error)[:120]} if cached else {'error': str(error)[:120]}
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / 'stats.json').write_text(json.dumps(fresh))
    return fresh


def toggle(mod_dir: str, state: str) -> None:
    settings = read_json(SETTINGS, {})
    dirs = [part for part in settings.get('env', {}).get('CLAUDE_CODE_PLUGIN_DIRS', '').split(':') if part]
    path = str(Path(mod_dir))
    if not path.startswith(str(MODS)):
        raise SystemExit(f'not one of your mods: {path}')
    dirs = [d for d in dirs if d != path] + ([path] if state == 'on' else [])
    CACHE.mkdir(parents=True, exist_ok=True)
    shutil.copy(SETTINGS, CACHE / 'settings.json.bak')
    settings.setdefault('env', {})['CLAUDE_CODE_PLUGIN_DIRS'] = ':'.join(dirs)
    SETTINGS.write_text(json.dumps(settings, indent=2) + '\n')
    print(json.dumps({'ok': True, 'isOn': state == 'on'}))


MODS, REPO, OWNER_REPO = Path('.'), None, None


def main() -> None:
    global MODS, REPO, OWNER_REPO
    MODS, REPO, OWNER_REPO = where()
    if sys.argv[1:2] == ['toggle']:
        toggle(sys.argv[2], sys.argv[3])
        return
    if sys.argv[1:2] == ['apply']:
        apply(sys.argv[2:])
        return
    refresh = '--tests' in sys.argv
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        mine = pool.submit(yours, refresh)
        numbers = pool.submit(stats)
        print(json.dumps({'yours': mine.result(), 'installed': installed(), 'updates': updates(), 'stats': numbers.result(), 'repo': OWNER_REPO}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': f'{type(error).__name__}: {str(error)[:200]}'}))
        sys.exit(1)
