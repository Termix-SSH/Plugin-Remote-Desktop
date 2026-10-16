# Changelog

## 1.0.3

### Fixed

- Saved RDP hosts failed with "Failed to generate connection token" when the Session Recording plugin was turned off
- RDP sessions on some touch screens in Chrome kept resizing as a scrollbar showed and hid

## 1.0.2

### Fixed

- VNC without a username and hosts behind jump hosts hung at "Negotiating VNC handshake" on Kubernetes. Without GUACD_TUNNEL_HOST set, guacd now reaches Termix by its pod IP

## 1.0.1

### Changed

- Translated into every supported language

## 1.0.0

### Added

- First release
- RDP, VNC and Telnet from any browser, in tabs and split screen like any other session
- Clipboard sync and file transfer through RDP drives
- Jump host support
- Session sharing and recording
- Open a host in the native Windows Remote Desktop client from the desktop app
- Connections need the remote desktop permission, only the server decides guacd paths, drive folders and VNC listen mode, and only admins set a host's own guacd
