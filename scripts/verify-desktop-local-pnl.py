"""Read-only native signing smoke. The short-lived JWT stays in process memory.

Requires SSH authorization to the product host. No credentials, account amounts
or bill rows are printed; native tests print only counts, demo flag and status.
"""
import argparse
import os
from pathlib import Path
import subprocess

REMOTE = '''
import asyncio
import asyncpg
from app.core.config import load_settings
from app.core.auth import create_access_token
async def main():
    settings = load_settings()
    conn = await asyncpg.connect(user=settings.postgres_user, password=settings.postgres_password,
        database=settings.postgres_db, host=settings.postgres_host, port=settings.postgres_port)
    try:
        admin = await conn.fetchval("SELECT id FROM users WHERE username='admin' AND role='admin' AND status='active'")
        if not admin: raise RuntimeError('active admin required')
        settings = settings.model_copy(update={'jwt_access_token_expire_minutes': 5})
        print(create_access_token(settings, str(admin), 'admin', 'live'))
    finally:
        await conn.close()
asyncio.run(main())
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ssh-key', required=True)
    parser.add_argument('--host', default='root@64.83.17.130')
    parser.add_argument('--base', default='https://b.00n.top')
    parser.add_argument('--full', action='store_true')
    args = parser.parse_args()
    result = subprocess.run(['ssh', '-i', args.ssh_key, '-oBatchMode=yes', args.host,
                             'docker exec -i crypto-backend python -'], input=REMOTE,
                            capture_output=True, text=True, timeout=30)
    if result.returncode or not result.stdout.strip().startswith('eyJ'):
        raise SystemExit('Cannot establish read-only authenticated smoke session')
    env = dict(os.environ, CYCLEPILOT_SMOKE_TOKEN=result.stdout.strip(), CYCLEPILOT_SMOKE_BASE=args.base)
    root = Path(__file__).resolve().parents[1]
    if args.full:
        build = subprocess.run(['cargo', 'test', '--lib', '--no-run', '--message-format=json'], cwd=root / 'src-tauri',
                               env=env, capture_output=True, text=True)
        import json
        executables = [json.loads(line).get('executable') for line in build.stdout.splitlines() if line.startswith('{')]
        exe = next((path for path in reversed(executables) if path), None)
        if build.returncode or not exe:
            raise SystemExit('Cannot build native smoke probe')
        env['CYCLEPILOT_SMOKE_EXE'] = exe
        result = subprocess.run(['pnpm.cmd', 'exec', 'vitest', 'run', 'src/lib/desktop-daily-pnl.smoke.test.ts'], cwd=root, env=env)
    else:
        result = subprocess.run(['cargo', 'test', '--lib', 'okx_analytics::tests::deployed_snippet_read',
                                 '--', '--ignored', '--nocapture'], cwd=root / 'src-tauri', env=env)
    env.pop('CYCLEPILOT_SMOKE_TOKEN', None)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
