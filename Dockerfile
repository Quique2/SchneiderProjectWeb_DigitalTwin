FROM caddy:2-alpine
COPY dist/ /srv/
COPY Caddyfile /etc/caddy/Caddyfile
# PORT is injected by Railway at runtime; no fixed EXPOSE needed
