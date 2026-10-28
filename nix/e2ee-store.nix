# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/edbadd28e4b1f589936fd2c7b44531b40d02627e.tar.gz";
  sha256 = "0ixycalnjra6m422knc05r5r0gpawl843923hw49125y3mgx4jc9";
}
