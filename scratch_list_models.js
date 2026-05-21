const apiKey = "AIzaSyDO6cRjSWmGT65CpOdTms-_c_TZAcQ3mBg";

async function listModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.models) {
      console.log(data.models.map(m => m.name).join("\n"));
    } else {
      console.log(JSON.stringify(data));
    }
  } catch (e) {
    console.error(e);
  }
}

listModels();
