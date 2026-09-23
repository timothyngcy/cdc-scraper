# Real Google Chrome on the Lambda Node 22 base image.
#
# Platform note: Google ships Chrome for Linux on x86_64 ONLY — there is no
# official ARM build. The scraper depends on real Chrome (Chromium's behaviour
# against this site's WAF is untested), so this image and the Lambda function
# must both be x86_64. On an Apple Silicon Mac that means a cross-build:
#   docker buildx build --platform linux/amd64 ...
# which CDK does for you when the function's architecture is X86_64.
FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:22

# Google's yum repo, then Chrome. dnf resolves the (many) shared-library deps
# that a headless browser needs — installing them by hand is how you end up
# debugging missing libnss at 1am.
# NOTE: dnf5 (Amazon Linux 2023) will not take an .rpm URL as a package argument,
# so we register the repo rather than pointing at the direct download.
RUN printf '%s\n' \
      '[google-chrome]' \
      'name=google-chrome' \
      'baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64' \
      'enabled=1' \
      'gpgcheck=1' \
      'gpgkey=https://dl.google.com/linux/linux_signing_key.pub' \
      > /etc/yum.repos.d/google-chrome.repo \
 && dnf install -y google-chrome-stable \
 && dnf clean all \
 && rm -rf /var/cache/dnf

ENV CHROME_PATH=/opt/google/chrome/chrome

# Chrome writes profile and cache data at startup. Lambda's filesystem is
# read-only except /tmp, so point HOME there.
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp

# Playwright drives the Chrome installed above, so skip its browser download
# (~400MB of Chromium we would never launch).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY lambda/ ./lambda/

CMD [ "lambda/handler.handler" ]
