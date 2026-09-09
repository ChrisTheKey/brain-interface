#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
  printf '%s\n' 'Please run this script as root in the Hetzner console.' >&2
  exit 1
fi
if [ "$(getent passwd forge | cut -d: -f6)" != /home/forge ]; then
  printf '%s\n' 'Unexpected forge home directory; no changes made.' >&2
  exit 1
fi
test -d /home/forge
if [ -L /home/forge ] || [ -L /home/forge/.ssh ] || [ -L /home/forge/.ssh/authorized_keys ]; then
  printf '%s\n' 'SSH path is a symlink; no changes made.' >&2
  exit 1
fi
if [ -e /home/forge/.ssh/authorized_keys ] && [ ! -f /home/forge/.ssh/authorized_keys ]; then
  printf '%s\n' 'authorized_keys is not a regular file; no changes made.' >&2
  exit 1
fi
group=$(id -gn forge)
install -d -m 700 -o forge -g "$group" /home/forge/.ssh
touch /home/forge/.ssh/authorized_keys
key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFzrodzyGHXv8qYCZQP/6osQDIGAbxWeHUcRXAih3llp zero-laptop-20260909'
if ! grep -qxF "$key" /home/forge/.ssh/authorized_keys; then
  printf '\n%s\n' "$key" >> /home/forge/.ssh/authorized_keys
fi
chown forge:"$group" /home/forge/.ssh/authorized_keys
chmod 600 /home/forge/.ssh/authorized_keys
printf '%s\n' 'ZERO SSH key installed for forge. Existing keys preserved.'
