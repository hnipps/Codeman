-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Format: 3.0 (quilt)
Source: at-spi2-core
Binary: at-spi2-core, at-spi2-common, at-spi2-core-udeb, libatspi2.0-0t64, libatspi0-udeb, libatspi2.0-dev, gir1.2-atspi-2.0, at-spi2-doc, libatk-adaptor, libatk-adaptor-udeb, libatk-bridge2.0-0t64, libatk-bridge-2.0-0-udeb, libatk-bridge2.0-dev, libatk1.0-0t64, libatk1.0-udeb, libatk1.0-dev, libatk1.0-doc, gir1.2-atk-1.0
Architecture: any all
Version: 2.52.0-1build1
Maintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>
Uploaders: Samuel Thibault <sthibault@debian.org>, Jordi Mallach <jordi@debian.org>
Homepage: https://wiki.gnome.org/Accessibility
Standards-Version: 4.6.2
Vcs-Browser: https://salsa.debian.org/a11y-team/at-spi2-core
Vcs-Git: https://salsa.debian.org/a11y-team/at-spi2-core.git
Testsuite: autopkgtest
Testsuite-Triggers: @builddeps@, build-essential, dbus, dbus-daemon, xauth, xvfb
Build-Depends: dpkg-dev (>= 1.22.5), debhelper-compat (= 13), dbus, libdbus-1-dev, dbus-broker [linux-any], libsystemd-dev [linux-any], libglib2.0-dev (>= 2.62), libxml2-dev, libx11-dev, libxtst-dev, meson (>= 0.63.0), pkgconf, gtk-doc-tools, gi-docgen, python3-sphinx, gir1.2-dbus-1.0-dev, gir1.2-glib-2.0-dev, gir1.2-gobject-2.0-dev, gobject-introspection | dh-sequence-gir, xauth <!nocheck>, xvfb <!nocheck>, at-spi2-core <!nocheck>
Build-Depends-Indep: docbook-xml <!nodoc>, libglib2.0-doc <!nodoc>, libglib2.0-dev-bin <!nodoc>
Package-List:
 at-spi2-common deb misc optional arch=all
 at-spi2-core deb misc optional arch=any
 at-spi2-core-udeb udeb debian-installer optional arch=any
 at-spi2-doc deb doc optional arch=all
 gir1.2-atk-1.0 deb introspection optional arch=any
 gir1.2-atspi-2.0 deb introspection optional arch=any
 libatk-adaptor deb misc optional arch=any
 libatk-adaptor-udeb udeb debian-installer optional arch=any
 libatk-bridge-2.0-0-udeb udeb debian-installer optional arch=any
 libatk-bridge2.0-0t64 deb libs optional arch=any
 libatk-bridge2.0-dev deb libdevel optional arch=any
 libatk1.0-0t64 deb libs optional arch=any
 libatk1.0-dev deb libdevel optional arch=any
 libatk1.0-doc deb doc optional arch=all profile=!nodoc
 libatk1.0-udeb udeb debian-installer optional arch=any
 libatspi0-udeb udeb debian-installer optional arch=any
 libatspi2.0-0t64 deb libs optional arch=any
 libatspi2.0-dev deb libdevel optional arch=any
Checksums-Sha1:
 cc7e5d0fde70663864ba7c2dc55c069df4b77b92 574684 at-spi2-core_2.52.0.orig.tar.xz
 c6b73d21742cbd8b313abd065810cbdb07ec4846 19940 at-spi2-core_2.52.0-1build1.debian.tar.xz
Checksums-Sha256:
 0ac3fc8320c8d01fa147c272ba7fa03806389c6b03d3c406d0823e30e35ff5ab 574684 at-spi2-core_2.52.0.orig.tar.xz
 20bda0a6815fb1e7c6ca286a02b4b70aaa706f304664aad30bd88a4ee163b91c 19940 at-spi2-core_2.52.0-1build1.debian.tar.xz
Files:
 e6591545b2bf204fe9a58f777bd0b78a 574684 at-spi2-core_2.52.0.orig.tar.xz
 fe0ddb0f35bf6106a71e2f9b1e423747 19940 at-spi2-core_2.52.0-1build1.debian.tar.xz
Original-Maintainer: Debian Accessibility Team <pkg-a11y-devel@alioth-lists.debian.net>

-----BEGIN PGP SIGNATURE-----

iQJHBAEBCgAxFiEET7WIqEwt3nmnTHeHb6RY3R2wP3EFAmYUAVUTHGp1bGlhbmtA
dWJ1bnR1LmNvbQAKCRBvpFjdHbA/cRjcEACjdgJUvrKqOJzdV9g9jcWmUmKgMyn0
LQFsLLSfnhOMTYV9F4sporS2lpIzNwqCwKlsXgGX3cY1x63fXuPeVeHTNh4AOaK0
2SZpEU2Rm8+vYgaRiMRKRswyXQCveT7v2pCHUYAvgqN+wHv5FvfPBJj081jlA1Rd
008Ym3RoTxGEoymvCW2fs9anXvRtTf90tWg4eFs/eAY5pJnGO5js4gNbPv9nnJNZ
CG3DRRkDS6NPEJPHDfxAqRCz1MeZGCKd37Ioad8oUkYwxRbVbO1gAc1ximdNsZUg
n8N84z/KCgLK5iXgAXRbKJt5KzhyQATtsHEtMIKHe0cUR9WEJwLfZoEic9/CCQwq
ibCdPSM7HdXHexIart9lxHJ77Zw/fWKTJcsqvXgrdlUb7gbv+wH5FCMLV2xLDRD+
Wci9YxLiPdctqT4cvGkuqLERWTVfEYE99nHaW6W5r0HoO+wRQRN9Zi+VefnyfIZM
lB8zDWjns2KRlUzd+bMlUGUpVV73nSULz3ohBHkI5sAHhINtq2mH/FhB8DFDDlsW
wLSV8q0918Kt12phiJEeDMxbl+ELZO9QODLI0JpJwkQbkloaTbqCa9Is5RvjuZ1b
QCahzRMVbgOJPWC+vsgeF4FTcZbM0ecP0XIwJmUcTUsj9YCh4DOiMPrNO3e2CZ/8
JEJqzkfpsSll3Q==
=ndlA
-----END PGP SIGNATURE-----
