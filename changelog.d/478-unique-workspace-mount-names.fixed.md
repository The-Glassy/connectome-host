- A recipe whose `modules.workspace.mounts` names two mounts alike is refused at load,
  naming the name and both mounts' indexes, instead of loading with the instructions
  check reading the first such mount while the workspace keeps the last (#478).
