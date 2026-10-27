FROM python:3.13-slim
WORKDIR /app
COPY server.py /app/server.py
RUN useradd --uid 10001 --create-home ktr && mkdir /data && chown ktr:ktr /data
USER ktr
ENV PYTHONUNBUFFERED=1 KTR_DB=/data/ktr.sqlite3
EXPOSE 8080
CMD ["python", "/app/server.py"]
