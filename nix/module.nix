# NixOS module: the media library.
#
#   imports = [ "${media-store}/nix/module.nix" ];
#   services.media-store.enable = true;
#
# Plain module, no flake: the packages are built with the host's own nixpkgs, like
# sashee/monitoring-platform's. The backend and its options come from e2ee-store's nix/lib.nix, at the version
# ./e2ee-store.nix pins. Reaching the socket from off the host (iroh, a reverse proxy) is the host's job; the
# socket's group is what grants access (backend SPEC §3.1).
#
# Admin commands run through the `media-store` wrapper as root, e.g. `sudo media-store user create alice`. It
# switches to the service user itself, so SQLite's WAL files can never end up owned by root.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.media-store;
  name = "media-store";
  e2eeStore = import ./e2ee-store.nix;
  e2ee = import (e2eeStore + "/nix/lib.nix") { inherit config lib pkgs; };
in
{
  # storageBackends included: tracks are offloadable, so they can live outside the database, or in several places.
  options.services.media-store = e2ee.options { inherit name; } // {
    enable = lib.mkEnableOption "the media-store media library backend";

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../web/package.nix {
        sdk = pkgs.callPackage (e2eeStore + "/sdk/package.nix") { };
      };
      defaultText = lib.literalExpression "pkgs.callPackage ../web/package.nix { sdk = …; }";
      description = "The frontend's static files, served by the backend.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        services.media-store.settings = {
          # Shown in passkey prompts; the app's own title.
          rp_name = lib.mkDefault "Media";
          # A track is one blob, sealed and padded: room for long ones.
          max_blob_size = lib.mkDefault "256MiB";
          # A session ends this long after the unlock, playing or not (backend SPEC §6): a day of listening per
          # unlock, rather than the backend's 4 hours.
          session_ttl = lib.mkDefault "24h";
        };
      }
      (e2ee.config {
        inherit name;
        inherit (cfg) package settings storageBackends;
        staticDir = "${cfg.webPackage}/share/media-store/web";
      })
    ]
  );
}
