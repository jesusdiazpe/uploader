import "./src/style.css";

// Local: tu backend corre en 3001
// En Render: lo pondrás con un env var VITE_API_BASE
const API = import.meta.env.VITE_API_BASE || "http://localhost:3001";

const fileInput = document.querySelector("#file");
const uploadBtn = document.querySelector("#upload");
const out = document.querySelector("#out");
const dropzone = document.querySelector("#dropzone");
const dropzoneText = document.querySelector("#dropzone-text");
const progressWrap = document.querySelector("#progress-wrap");
const progressBar = document.querySelector("#progress-bar");
const progressLabel = document.querySelector("#progress-label");

let selectedFile = null;

function setSelectedFile(file) {
  if (!file) return;
  if (!file.type?.startsWith("image/") && !file.type?.startsWith("video/")) {
    out.textContent = "Solo se permiten imágenes o videos.";
    return;
  }
  selectedFile = file;
  dropzoneText.textContent = `Seleccionado: ${file.name}`;
  uploadBtn.disabled = false;
  out.textContent = "";
}

dropzone.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  setSelectedFile(fileInput.files?.[0]);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  setSelectedFile(file);
});

function uploadWithProgress(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("image", file);

    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      const percent = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = `${percent}%`;
      progressLabel.textContent = `${percent}%`;
    });

    xhr.addEventListener("load", () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error(data?.error || "Error al subir el archivo"));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Error de red al subir el archivo")));
    xhr.addEventListener("abort", () => reject(new Error("Subida cancelada")));

    xhr.open("POST", `${API}/upload`);
    xhr.send(form);
  });
}

uploadBtn.onclick = async () => {
  const file = selectedFile;
  if (!file) return;

  uploadBtn.disabled = true;
  out.textContent = "Subiendo...";
  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressLabel.textContent = "0%";

  let data;
  try {
    data = await uploadWithProgress(file);
  } catch (err) {
    out.textContent = err.message || "Error";
    uploadBtn.disabled = false;
    progressWrap.classList.add("hidden");
    return;
  }

  progressWrap.classList.add("hidden");
  selectedFile = null;
  fileInput.value = "";
  dropzoneText.textContent = "Arrastra una imagen o video aquí, o haz clic para elegir";

  out.innerHTML = `
    <p id="view-link"><b>Link para ver:</b> <a target="_blank" href="${data.viewUrl}">${data.viewUrl}</a></p>
    <p><b>Eliminar archivo:</b> <button id="delete-image" type="button">Eliminar</button></p>
    <p style="opacity:.7;font-size:13px">Solo existe 1 archivo activo. Si subes otro, se reemplaza. El límite es de 8 MB.</p>
  `;

  const deleteBtn = document.querySelector("#delete-image");
  const viewLink = document.querySelector("#view-link");

  deleteBtn?.addEventListener("click", async () => {
    const confirmed = window.confirm("¿Seguro que quieres eliminar el archivo?");
    if (!confirmed) return;

    deleteBtn.disabled = true;
    deleteBtn.textContent = "Eliminando...";

    try {
      const deletePath = new URL(data.deleteUrl).pathname;
      const deleteRes = await fetch(`${API}${deletePath}`, {
        method: "GET",
        credentials: "omit",
      });

      if (!deleteRes.ok) {
        deleteBtn.disabled = false;
        deleteBtn.textContent = "Eliminar";
        out.textContent = "No se pudo eliminar el archivo.";
        return;
      }

      viewLink?.remove();
      out.innerHTML = `
        <p>Archivo eliminado.</p>
        <p style="opacity:.7;font-size:13px">Ya no hay un archivo activo.</p>
      `;
      fileInput.value = "";
    } catch {
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Eliminar";
      out.textContent = "No se pudo eliminar el archivo.";
    }
  });
};
