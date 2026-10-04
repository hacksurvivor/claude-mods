#!/usr/bin/env python3
"""Copies the images of the person's last message in a Claude Code session.

Usage: shot.py <session id> <out dir> <file prefix>
Prints a JSON list of the files written (empty when the message had none).
Reads the session's transcript under ~/.claude/projects; writes only into <out dir>.
"""

import base64
import glob
import json
import os
import sys

EXTENSIONS = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'}


def last_images(transcript: str) -> list[dict]:
    """The image blocks of the last message the person typed (tool results don't count)."""
    images: list[dict] = []
    with open(transcript, errors='ignore') as lines:
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get('type') != 'user':
                continue
            content = (row.get('message') or {}).get('content')
            if isinstance(content, str):
                images = []
            elif isinstance(content, list) and not any(block.get('type') == 'tool_result' for block in content):
                images = [block for block in content if block.get('type') == 'image']
    return images


def main() -> None:
    session, out_dir, prefix = sys.argv[1:4]
    found = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{session}.jsonl'))
    if not found:
        print('[]')
        return
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for at, block in enumerate(last_images(found[0])):
        source = block.get('source') or {}
        if source.get('type') != 'base64':
            continue
        path = os.path.join(out_dir, f"{prefix}-{at + 1}.{EXTENSIONS.get(source.get('media_type'), 'png')}")
        with open(path, 'wb') as out:
            out.write(base64.b64decode(source.get('data', '')))
        written.append(path)
    print(json.dumps(written))


if __name__ == '__main__':
    main()
