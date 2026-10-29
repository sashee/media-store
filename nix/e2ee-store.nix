# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/4d60c87f119c0695d3ed4d47b62abaa99a4141f3.tar.gz";
  sha256 = "12rspfsndsivc0v23za9rxvg24flm0cjq0wx80yyna6yn1489z8q";
}
