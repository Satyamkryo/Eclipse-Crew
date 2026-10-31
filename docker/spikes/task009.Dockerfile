FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# Build-time fixture only: runtime never provisions users or repairs permissions.
RUN useradd --uid 20001 --user-group --create-home --shell /bin/bash agent_a \
    && useradd --uid 20002 --user-group --create-home --shell /bin/bash agent_b \
    && for agent in agent_a agent_b; do \
         install -d -m 700 -o "$agent" -g "$agent" \
           "/home/$agent/inbox" "/home/$agent/outbox" "/home/$agent/work" \
           "/home/$agent/Downloads" "/home/$agent/.config" "/home/$agent/.config/chromium"; \
         chmod 700 "/home/$agent"; \
       done \
    && for tool in bash stat timeout dd sha256sum date mv cmp find sync; do command -v "$tool"; done \
    && ! command -v sudo

USER 20001:20001
WORKDIR /home/agent_a
CMD ["sleep", "infinity"]
