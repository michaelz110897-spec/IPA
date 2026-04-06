import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const status = document.getElementById("status");
const viewer = document.getElementById("viewer");

const params = new URLSearchParams(location.search);
const fileUrl = params.get("file");

if (!fileUrl) {
  status.textContent = "No PDF specified.";
} else {
  loadPdf(fileUrl).catch((err) => {
    console.error(err);
    status.textContent = "Failed to load PDF: " + (err && err.message ? err.message : err);
  });
}

async function loadPdf(url) {
  const loadingTask = pdfjsLib.getDocument({ url });
  const pdf = await loadingTask.promise;
  status.textContent = "";

  const scale = 1.5;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const pageDiv = document.createElement("div");
    pageDiv.className = "page";
    pageDiv.style.width = viewport.width + "px";
    pageDiv.style.height = viewport.height + "px";
    pageDiv.setAttribute("data-page-number", String(pageNum));

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageDiv.appendChild(canvas);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.style.width = viewport.width + "px";
    textLayerDiv.style.height = viewport.height + "px";
    pageDiv.appendChild(textLayerDiv);

    viewer.appendChild(pageDiv);

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const textContent = await page.getTextContent();
    await pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
      textDivs: [],
    }).promise;
  }
}
