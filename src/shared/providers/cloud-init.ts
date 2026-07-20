/**
 * Generate a cloud-init user-data script for provisioning servers.
 * The base script installs Docker, hardens SSH, and enables unattended
 * upgrades. Traefik is NOT installed here — it runs on the panel server only
 * (the panel bootstrap installs it explicitly over SSH), so workers stay
 * Traefik-free. Provider-specific packages/commands can be injected.
 */
export function cloudInitScript(opts?: {
  extraPackages?: string[];
  extraCommands?: string[];
}): string {
  const packages = [
    "unattended-upgrades",
    ...(opts?.extraPackages ?? []),
    "fail2ban",
  ];
  const extraCmds = (opts?.extraCommands ?? []).join("\n");

  return `#!/bin/bash
exec > /var/log/cloud-init-deploy.log 2>&1
set -x

# Wait for apt/dpkg locks (unattended-upgrades runs on fresh Ubuntu)
wait_for_apt() {
  local max=60
  for i in $(seq 1 $max); do
    if ! fuser /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for apt lock... ($i/$max)"
    sleep 5
  done
  echo "WARNING: apt lock wait timed out"
}

wait_for_apt

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# docker-ce image already includes Docker, curl, git
# Firewall is handled by cloud provider firewall (not UFW)
apt-get update -qq || { sleep 10; wait_for_apt; apt-get update -qq; }
apt-get install -y -qq ${packages.join(" ")} || { sleep 10; wait_for_apt; apt-get install -y -qq ${packages.join(" ")}; }
${extraCmds}

# Create deploy user for running containers
useradd -m -s /bin/bash deploy
usermod -aG docker deploy

# SSH hardening: disable root password login, only allow key-based auth
sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
systemctl reload sshd || systemctl reload ssh || true

# fail2ban: protect SSH against brute-force
cat > /etc/fail2ban/jail.local <<'F2B'
[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 5
bantime = 3600
findtime = 600
F2B
systemctl enable fail2ban
systemctl restart fail2ban

# Enable automatic security updates
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTOUPGRADE
systemctl enable unattended-upgrades

# Signal ready
touch /root/.provisioned
`;
}
