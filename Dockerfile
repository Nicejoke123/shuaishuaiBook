FROM python:3.10-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt -i https://mirrors.tencent.com/pypi/simple/
COPY . .
EXPOSE 80
CMD ["python", "server.py"]
