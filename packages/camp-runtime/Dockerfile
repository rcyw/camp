ARG BASE_IMAGE=node:24-trixie
FROM ${BASE_IMAGE}
COPY .local/node /usr/local/bin/node

# LayerFS owns the root daemon. DSH runs only as this non-root command identity.
RUN useradd --uid 501 --gid 20 --create-home --home-dir /home/camp camp \
    && mkdir -p /opt/camp-dsh /tmp/camp-dsh-home \
    && chown 501:20 /tmp/camp-dsh-home
ENV HOME=/home/camp
WORKDIR /tmp
# The trusted manager installs the exact built DSH runtime into /opt/camp-dsh.
# No Docker socket, host home, Store credential, or worker credential is mounted.
