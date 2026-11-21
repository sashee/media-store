# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/ee85f8c8b6de7dda66786893e231730df4b28d6b.tar.gz";
  sha256 = "0x1c4fdi09lnfdw0r9f49j3skzn7bdmh0v24dljpghbzkqgbh437";
}
