# NixOS VM test of the module (../module.nix): e2ee-store's instance test (the service, the socket's access
# control, the admin wrapper and the sandbox) on the `media-store` instance, plus a check that the media library
# is what it serves.
#
# The machine is an input, so a host repository runs this against its real configuration, the way
# sashee/nixos-test runs monitoring-platform's harness:
#
#   import "${media-store}/nix/tests/lib.nix" { inherit pkgs; machineModules = [ <host config> ]; }
{
  pkgs,
  machineModules,
}:
import (import ../e2ee-store.nix + "/nix/tests/lib.nix") {
  inherit pkgs;
  instance = "media-store";
  machineModules = machineModules ++ [
    ../module.nix
    { services.media-store.enable = true; }
  ];
  extraTestScript = ''
    with subtest("the media library is served"):
        assert "<title>Media</title>" in get("/", CLIENT)
  '';
}
