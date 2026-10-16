#!/usr/bin/env python3
"""Installer regression tests: only mocked HTTP and disposable shell profiles.

Run with python3 scripts/test-download.py. No downloaded file is executed.
Requires a glibc runner: the installer also checks the real /lib for musl loaders.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).with_name('download.sh').resolve()
REPO = 'VibeEngineeringAI/parseable'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='parseable-installer-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home with spaces'
        self.home.mkdir()
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        # A closed PATH ensures missing-downloader tests cannot contact the network.
        for name in ('tr', 'grep', 'sed', 'head', 'mkdir', 'rmdir', 'rm', 'chmod', 'mv', 'tail'):
            (self.tools / name).symlink_to(shutil.which(name))
        self.env = dict(os.environ, HOME=str(self.home), PATH=str(self.tools),
                        SHELL='/bin/bash', MOCK_OS='Linux', MOCK_ARCH='x86_64',
                        MOCK_LIBC='glibc', MOCK_FAILURE='',
                        MOCK_LOG=str(self.root / 'requests'))
        self.mock('uname', '''case "$1" in
-m) printf '%s\\n' "$MOCK_ARCH" ;;
-s) printf '%s\\n' "$MOCK_OS" ;;
esac''')
        self.mock('ldd', "printf '%s\\n' \"$MOCK_LIBC\"")

    def mock(self, name, body):
        path = self.tools / name
        path.write_text('#!/bin/sh\n' + body + '\n')
        path.chmod(0o755)

    def downloader(self, name='curl'):
        self.mock(name, '''output=''
url=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o|-O) output=$2; shift ;;
        https://*) url=$1 ;;
    esac
    shift
done
printf '%s\\n' "$url" >> "$MOCK_LOG"
case "$url" in
    https://api.github.com/repos/VibeEngineeringAI/parseable/releases/latest)
        [ "$MOCK_FAILURE" = metadata ] && exit 22
        if [ "$MOCK_FAILURE" = missing_tag ]; then
            printf '{"message":"Not Found"}\\n'
        else
            printf '{"tag_name": "v1.2.3"}\\n'
        fi
        ;;
    https://github.com/VibeEngineeringAI/parseable/releases/download/v1.2.3/*)
        printf 'mock binary, never execute\\n' > "$output"
        [ "$MOCK_FAILURE" = download ] && exit 22
        ;;
    *) printf 'Unexpected network request: %s\\n' "$url" >&2; exit 99 ;;
esac
exit 0''')

    def run_installer(self, **env):
        return subprocess.run(['/bin/sh', str(INSTALLER)], env=dict(self.env, **env),
                              capture_output=True, text=True)

    def requests(self):
        path = self.root / 'requests'
        return path.read_text().splitlines() if path.exists() else []

    def test_platform_assets_and_downloaders(self):
        platforms = [('Linux', 'x86_64', 'x86_64-unknown-linux-gnu'),
                     ('Linux', 'amd64', 'x86_64-unknown-linux-gnu'),
                     ('Linux', 'aarch64', 'aarch64-unknown-linux-gnu'),
                     ('Linux', 'arm64', 'aarch64-unknown-linux-gnu'),
                     ('Darwin', 'arm64', 'aarch64-apple-darwin')]
        for downloader in ('curl', 'wget'):
            self.downloader(downloader)
            for system, arch, asset in platforms:
                with self.subTest(downloader=downloader, system=system, arch=arch):
                    result = self.run_installer(MOCK_OS=system, MOCK_ARCH=arch)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.requests()[-2:], [
                        f'https://api.github.com/repos/{REPO}/releases/latest',
                        f'https://github.com/{REPO}/releases/download/v1.2.3/Parseable_OSS_{asset}'])
                    binary = self.home / '.parseable/bin/parseable'
                    self.assertEqual(binary.read_text(), 'mock binary, never execute\n')
                    self.assertTrue(os.access(binary, os.X_OK))
                    shutil.rmtree(self.home / '.parseable')
            (self.tools / downloader).unlink()

    def test_no_downloader_fails_without_installation(self):
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Neither curl nor wget', result.stderr)
        self.assertFalse((self.home / '.parseable').exists())

    def test_unsupported_platforms_and_musl_fail_before_network(self):
        self.downloader()
        for system, arch, libc in [('Darwin', 'x86_64', 'glibc'),
                                   ('Linux', 'riscv64', 'glibc'),
                                   ('Windows', 'x86_64', 'glibc'),
                                   ('Linux', 'x86_64', 'musl libc')]:
            with self.subTest(system=system, arch=arch, libc=libc):
                result = self.run_installer(MOCK_OS=system, MOCK_ARCH=arch, MOCK_LIBC=libc)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.requests(), [])
                self.assertFalse((self.home / '.parseable').exists())

    def test_release_failures_leave_home_unchanged(self):
        self.downloader()
        for failure in ('metadata', 'missing_tag'):
            with self.subTest(failure=failure):
                result = self.run_installer(MOCK_FAILURE=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(list(self.home.iterdir()), [])
                self.assertNotIn('successfully installed', result.stdout)

    def test_failed_asset_download_cleans_up_and_can_be_retried(self):
        self.downloader()
        result = self.run_installer(MOCK_FAILURE='download')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual(self.run_installer().returncode, 0)

    def test_existing_installation_is_preserved(self):
        self.downloader()
        binary = self.home / '.parseable/bin/parseable'
        binary.parent.mkdir(parents=True)
        binary.write_text('keep existing binary')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(binary.read_text(), 'keep existing binary')
        self.assertEqual(len(self.requests()), 1)
        self.assertFalse((self.home / '.bashrc').exists())

    def test_bash_profiles_are_not_sourced_and_path_is_not_duplicated(self):
        self.downloader()
        profile = self.home / '.profile'
        profile.write_text('touch "${HOME}/profile-was-sourced"')
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        path_line = f'export PATH="{self.home}/.parseable/bin:$PATH"'
        self.assertEqual(profile.read_text(), 'touch "${HOME}/profile-was-sourced"\n' + path_line + '\n')
        self.assertEqual((self.home / '.bashrc').read_text(), path_line + '\n')
        self.assertFalse((self.home / 'profile-was-sourced').exists())
        shutil.rmtree(self.home / '.parseable')
        self.assertEqual(self.run_installer().returncode, 0)
        self.assertEqual(profile.read_text().count(path_line), 1)
        self.assertEqual((self.home / '.bashrc').read_text().count(path_line), 1)

    def test_zsh_respects_zdotdir(self):
        self.downloader()
        zdotdir = self.root / 'zsh profiles'
        zdotdir.mkdir()
        result = self.run_installer(SHELL='/bin/zsh', ZDOTDIR=str(zdotdir))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((zdotdir / '.zshrc').exists())
        self.assertFalse((self.home / '.zshrc').exists())

    def test_unknown_shell_prints_manual_path_without_profile_changes(self):
        self.downloader()
        result = self.run_installer(SHELL='/bin/fish')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('To use Parseable in the current shell', result.stdout)
        self.assertEqual([path.name for path in self.home.iterdir()], ['.parseable'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
