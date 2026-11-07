# The marketing site: static files behind nginx, running as an unprivileged user on port 8080.
# Build from this folder:  docker build -t seoconsole-site site/
# On Coolify: a Dockerfile resource with the base directory set to /site and the exposed port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY index.html robots.txt sitemap.xml favicon.svg favicon.ico favicon-32.png apple-touch-icon.png icon-192.png icon-512.png /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
