#!/bin/sh
set -eu

mkdir -p /run/cosmosh-fixture
chmod 700 /run/cosmosh-fixture
cp /run/fixture-host-key /run/cosmosh-fixture/host_key
chmod 600 /run/cosmosh-fixture/host_key
python3 /usr/local/lib/cosmosh-fixture-prepare.py
exec /usr/sbin/sshd -D -e
