ARG DESKTOP_IMAGE
FROM ${DESKTOP_IMAGE}
COPY network-namespace.py /opt/eclipse/network-namespace.py
USER 0:0
ENTRYPOINT ["python3", "/opt/eclipse/network-namespace.py"]
CMD []
