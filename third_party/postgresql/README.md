# Native PostgreSQL notice inventory

The application pins native PostgreSQL 18.4 through embedded-postgres 18.4.0-beta.17. The files in this directory retain the PostgreSQL project copyright, the upstream binary distribution Apache license, the wrapper MIT license, and the installed npm distribution license. `notice-sources.json` records the exact retrieval URLs and content digests. `native-darwin-arm64-inventory.json` records the shipped native file names, sizes and digests for this tested host.

This collection is incomplete for redistribution qualification. The native payload also contains libraries including OpenSSL, ICU, libxml2, zlib, zstd, libiconv, libintl, Kerberos, libedit and libuuid. Their exact source versions, notices, build configuration and any applicable source or relinking requirements still need to be matched to the binary distribution before trusted public distribution. The package-level MIT/Apache licenses do not establish the licenses of every bundled library. Nothing here asserts that the binary payload is fully cleared for redistribution.

The binary package currently available from the selected npm provider is PostgreSQL 18.4; upstream PostgreSQL has released newer patch versions. There is no runtime download or silent version upgrade. A pinned package refresh and regression qualification are required to update it.
