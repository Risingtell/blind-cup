import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const deployed = await hre.deployments.deploy("BlindCup", { from: deployer, log: true });
  console.log(`BlindCup contract: ${deployed.address}`);
};
export default func;
func.id = "deploy_blindCup";
func.tags = ["BlindCup"];
