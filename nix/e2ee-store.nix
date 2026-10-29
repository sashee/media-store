# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/eae7ae64d72348074fb705a89535ddb7e5f6e896.tar.gz";
  sha256 = "04j883gdh5pizwjk9x28fkyhwiwa9gk57bc6yl4c1a06rgk6bcbg";
}
