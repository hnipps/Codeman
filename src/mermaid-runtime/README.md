# Mermaid native runtime

This directory preserves the native libraries needed by Chromium headless shell
on the tested Ubuntu 24.04 x64 base image. It is not a complete Linux runtime or
an offline backup of Chromium, Node.js, npm packages, or Codeman session data.

The platform bundle contains unmodified shared libraries from Ubuntu packages.
`manifest.json` records package versions, official package URLs, SHA-256 hashes,
and hashes of every distributed file. `licenses/` retains the package notices
and applicable GNU license texts. `sources/` includes the matching LGPL upstream
and distribution source archives, with their original source-package metadata.
These third-party files retain their own licenses, not Codeman's license.

After a normal package installation and build, restore an instance with:

```sh
codeman mermaid setup
```

For a VM where you explicitly accept disabling Chromium's OS sandbox:

```sh
codeman mermaid setup --no-sandbox
```

Setup verifies the bundle, copies it into the instance data directory, and writes
the renderer configuration. It does not install system packages. Repeating the
same setup verifies existing files and leaves them intact. A different existing
configuration or modified native library is refused, not overwritten.

Only Ubuntu 24.04 x64 is supported by this bundle. Other systems can use their
own native packages and renderer configuration. Normal npm and pinned Chromium
downloads are still required during recovery.

To update the bundle on Ubuntu with `dpkg-deb` installed:

```sh
node scripts/vendor-mermaid-runtime.mjs
```

The generator pins binary-package checksums and matching source metadata. An
optional directory argument reuses downloaded `.deb` files after verifying them.
Update the pins, regenerate, inspect the notices and corresponding source, and
exercise setup and actual rendering before committing an update.
