# NixOS module: the media library, as an instance of e2ee-store's module (nix/module.nix there) named `media-store`.
#
#   imports = [ "${media-store}/nix/module.nix" ];
#   services.media-store.enable = true;
#
# Plain module, no flake: the packages are built with the host's own nixpkgs, like
# sashee/monitoring-platform's. Reaching the socket from off the host (iroh, a reverse proxy) is the
# host's job; the socket's group is what grants access (backend SPEC §3.1).
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
  settingsFormat = pkgs.formats.toml { };
in
{
  imports = [ (e2eeStore + "/nix/module.nix") ];

  options.services.media-store = {
    enable = lib.mkEnableOption "the media-store media library backend";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage (e2eeStore + "/backend/package.nix") { };
      defaultText = lib.literalExpression "pkgs.callPackage \"\${e2ee-store}/backend/package.nix\" { }";
      description = "The backend.";
    };

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../web/package.nix {
        sdk = pkgs.callPackage (e2eeStore + "/sdk/package.nix") { };
      };
      defaultText = lib.literalExpression "pkgs.callPackage ../web/package.nix { sdk = …; }";
      description = "The frontend's static files, served by the backend.";
    };

    settings = lib.mkOption {
      type = lib.types.submodule { freeformType = settingsFormat.type; };
      default = { };
      example = {
        public_hosts = [ "media.example.com" ];
        blob_target = [ "s3" ];
      };
      description = ''
        The backend's configuration file (backend SPEC §10). `socket`, `database` and `static_dir`
        are set by e2ee-store's module. Storage backends for the tracks, which are offloadable, are e2ee-store's
        `services.e2ee-store.instances.media-store.storageBackends`.
      '';
    };

    socketPath = lib.mkOption {
      type = lib.types.str;
      default = "/run/${name}/backend.sock";
      readOnly = true;
      description = "The socket the backend listens on, for whatever forwards to it.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = name;
      readOnly = true;
      description = "User the backend runs as; it owns the data in /var/lib/media-store.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = name;
      readOnly = true;
      description = "Group that may connect to {option}`socketPath`.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.e2ee-store.instances.${name} = {
      inherit (cfg) package;
      staticDir = "${cfg.webPackage}/share/media-store/web";
      settings = lib.mkMerge [
        {
          # Shown in passkey prompts; the app's own title.
          rp_name = lib.mkDefault "Media";
          # A track is one blob, sealed and padded: room for long ones.
          max_blob_size = lib.mkDefault "256MiB";
          # A session ends this long after the unlock, playing or not (backend SPEC §6): a day of listening per
          # unlock, rather than the backend's 4 hours.
          session_ttl = lib.mkDefault "24h";
        }
        cfg.settings
      ];
    };
  };
}
