ARG PYTHON_IMAGE=python:3.11-slim-bookworm
FROM ${PYTHON_IMAGE} AS source
RUN apt-get -o Acquire::Retries=3 update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /rea-video
RUN git init -q \
  && git remote add origin https://github.com/JuneYaooo/rea-video.git \
  && git sparse-checkout set --no-cone /rea_video/ /pyproject.toml /README.md /LICENSE \
  && git fetch --filter=blob:none --depth=1 origin 99033f7ec8e2ddd51da40259d99d679897860c95 \
  && git checkout -q --detach FETCH_HEAD

FROM ${PYTHON_IMAGE}
RUN apt-get -o Acquire::Retries=3 update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ffmpeg fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
COPY --from=source /rea-video/pyproject.toml /rea-video/README.md /rea-video/LICENSE /opt/rea-video/
COPY --from=source /rea-video/rea_video /opt/rea-video/rea_video
ENV REA_VIDEO_MODELS=/opt/rea-video-models
# RapidOCR uses the existing headless OpenCV build in the worker.
RUN pip install --no-cache-dir '/opt/rea-video[asr]' 'shapely!=2.0.4,>=1.7.1' pyclipper six tqdm \
  && pip install --no-cache-dir --no-deps 'rapidocr-onnxruntime>=1.3,<2' \
  && python -c 'from rea_video.speech import ensure_models; from rea_video.stems import ensure_model; from rea_video.overlay import get_ocr; ensure_models(); ensure_model(); assert get_ocr() is not None'
ENV PYTHONDONTWRITEBYTECODE=1 REA_VIDEO_HOME=/tmp/rea-home REA_VIDEO_THREADS=2 HOME=/tmp
WORKDIR /worker
COPY server.py capacity.py edit.py audio.py speech.py captions.py ./
USER 10001:10001
CMD ["python", "server.py"]
