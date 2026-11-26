# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/07afcba301adeeabfb98a9deae52123e34c9762d.tar.gz";
  sha256 = "1a4c7yawk1lm4mx4iq737lifvj7by2vnm09dsnqswf49v85m4ap9";
}
