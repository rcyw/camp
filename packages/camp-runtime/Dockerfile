ARG BASE_IMAGE=node:24.16.0-trixie@sha256:d0ba7acd944247d3530d89c1027126e811f64b243e794ce2c41f2d8800cbfbf8
FROM ${BASE_IMAGE}
ARG TOOLCHAIN_DIGEST
LABEL camp.toolchain.digest=${TOOLCHAIN_DIGEST} camp.runtime.dsh="0.2.1-rc.2"
# Node, npm, git and their libraries all come from the pinned official image.
# This recipe never copies an executable or shared library from the host.
RUN useradd --uid 501 --gid 20 --create-home --home-dir /home/camp camp \
    && mkdir -p /opt/camp-dsh /opt/camp-dsh-plugin /opt/camp-protocol /tmp/camp-dsh-home \
    && chown 501:20 /tmp/camp-dsh-home
COPY bundle/dsh-runtime.tar bundle/dsh-plugin.tar bundle/camp-protocol.tar /tmp/camp-install/
COPY bundle/manifest.json /opt/camp-toolchain/manifest.json
COPY bundle/licenses/ /opt/camp-toolchain/licenses/
RUN tar -xf /tmp/camp-install/dsh-runtime.tar -C /opt/camp-dsh \
    && tar -xf /tmp/camp-install/dsh-plugin.tar -C /opt/camp-dsh-plugin \
    && tar -xf /tmp/camp-install/camp-protocol.tar -C /opt/camp-protocol \
    && rm -r /tmp/camp-install \
    && node --version && npm --version && git --version \
    && node /opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version
ENV HOME=/home/camp
WORKDIR /tmp
